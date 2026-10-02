import { Inject, Injectable, Optional } from '@nestjs/common';
import { request } from 'undici';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  RagChatRetrievalSettings,
  RagEvidence,
  RagRetrievalMeta,
  RagRetrievalMode,
  RagRetrievalOverride,
  RagRetrievalSettings,
  RagRerankPort,
  RagRerankStatus,
  RAG_RERANK_PORT,
} from '../contracts';
import { RagRetrieverService } from './rag-retriever.service';
import {
  EXPANSION_TOP_K_MULTIPLIER,
  REWRITE_MAX_TOKENS,
  REWRITE_TEMPERATURE,
  RERANK_POOL_FLOOR,
  mergeRetrievalOverride,
  parseChatRetrievalSettings,
} from './retrieval-config';
import { buildExpansionVariants, parseRewriteOutput } from './query-rewrite';
import { applyRerankStage, buildModelPassage } from './rerank';
import { OutboundAgentFactory } from '../../../../integrations/outbound/outbound-agent.factory';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { chatUrlFor, providerHeadersFor } from '../../ai.service';
import {
  readWorkspaceAiProvider,
  WorkspaceAiProvider,
} from '../embedding/provider-settings';

export interface RagChatActor {
  userId: string;
  workspaceId: string;
}

export interface RagChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string | null;
}

export interface RagChatRetrievalInput {
  query: string;
  history?: RagChatHistoryTurn[];
  attachmentFileNames?: string[];
  spaceId?: string;
  overrides?: RagRetrievalOverride;
}

export interface RagChatRetrievalOutput {
  evidence: RagEvidence[];
  rewrittenQuery: string;
  rewriteApplied: boolean;
  expansionVariants: string[];
  retrieval: RagRetrievalMeta;
}

/**
 * Chat query-understanding and hybrid retrieval (docmost-rag-v1 contract 12,
 * ported from Tencent/WeKnora bccb4b1 chat pipeline): optional model rewrite
 * of the query with conversation history (failure falls back to the original
 * query), hybrid recall/fusion, local query expansion when the initial recall
 * falls short of the configured recall count, and exactly ONE final rerank
 * stage at this boundary. The retriever runs in skipRerank mode so the chat
 * rerank cannot double-apply, and chat reads the independent chat defaults
 * (all RetrievalConfig fields) merged with the per-request overrides, never
 * the search defaults.
 *
 * Authorization: every chunk returned here passed the retriever's
 * recheck-at-return boundary (space membership plus page-level restrictions,
 * rechecked immediately before evidence leaves RagRetrieverService). The
 * rewrite and rerank stages transform already-authorized evidence in memory
 * and issue no new fetches, so no second authorization gap exists here; the
 * chat caller rechecks current authorization again before model stages and
 * final output.
 */
@Injectable()
export class RagChatRetrievalService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly retriever: RagRetrieverService,
    private readonly outboundAgent: OutboundAgentFactory,
    private readonly environment: EnvironmentService,
    private readonly encryption: EncryptionService,
    @Optional()
    @Inject(RAG_RERANK_PORT)
    private readonly rerankPort?: RagRerankPort,
  ) {}

  async retrieveForChat(
    actor: RagChatActor,
    input: RagChatRetrievalInput,
  ): Promise<RagChatRetrievalOutput> {
    const stored = await this.readStoredSettings(actor.workspaceId);
    const chat = parseChatRetrievalSettings(stored.chatRetrievalSettings);
    const retrieval = mergeRetrievalOverride(
      stored.chatRetrievalSettings,
      input.overrides,
    );
    const mode: RagRetrievalMode = 'hybrid';

    const rewrite = chat.rewriteEnabled
      ? await this.rewriteQuery(actor.workspaceId, chat, input)
      : { rewrittenQuery: input.query.trim(), applied: false };
    const rewrittenQuery = rewrite.rewrittenQuery || input.query.trim();
    if (!rewrittenQuery) {
      return {
        evidence: [],
        rewrittenQuery: '',
        rewriteApplied: false,
        expansionVariants: [],
        retrieval: { mode, rerankStatus: 'not_applicable' },
      };
    }

    let evidence = await this.retriever
      .retrieve(actor, {
        query: rewrittenQuery,
        mode,
        limit: retrieval.recallCount,
        ...(input.spaceId ? { spaceId: input.spaceId } : {}),
        ...(input.overrides ? { overrides: input.overrides } : {}),
        skipRerank: true,
      })
      .then((result) => result.evidence);

    // query_expansion.go: when the initial recall falls short of the
    // configured recall count, run keyword-only retrieval over local query
    // variants and merge with deduplication (best score per chunk).
    const expansionVariants: string[] = [];
    if (chat.expansionEnabled && evidence.length < retrieval.recallCount) {
      const expTopK = Math.max(
        retrieval.recallCount * EXPANSION_TOP_K_MULTIPLIER,
        retrieval.rerankTopK * EXPANSION_TOP_K_MULTIPLIER,
      );
      for (const variant of buildExpansionVariants(
        rewrittenQuery,
        input.query,
      )) {
        expansionVariants.push(variant);
        try {
          const variantResult = await this.retriever.retrieve(actor, {
            query: variant,
            mode: 'keyword',
            limit: expTopK,
            ...(input.spaceId ? { spaceId: input.spaceId } : {}),
          });
          evidence = mergeByChunk(evidence, variantResult.evidence);
        } catch {
          // A failing variant never blocks the main recall.
        }
      }
    }

    const { evidence: reranked, rerankStatus } = await this.applyChatRerank(
      actor.workspaceId,
      input,
      evidence,
      retrieval,
    );
    return {
      evidence: reranked,
      rewrittenQuery,
      rewriteApplied: rewrite.applied,
      expansionVariants,
      retrieval: { mode, rerankStatus },
    };
  }

  private async applyChatRerank(
    workspaceId: string,
    input: RagChatRetrievalInput,
    evidence: RagEvidence[],
    retrieval: RagRetrievalSettings,
  ): Promise<{ evidence: RagEvidence[]; rerankStatus: RagRerankStatus }> {
    if (evidence.length === 0) {
      return { evidence: [], rerankStatus: 'not_applicable' };
    }
    if (!retrieval.rerankModel || !this.rerankPort) {
      return {
        evidence: evidence.slice(0, retrieval.recallCount),
        rerankStatus: 'not_configured',
      };
    }
    const byScore = [...evidence].sort(
      (left, right) => right.score.value - left.score.value,
    );
    const pool = byScore.slice(
      0,
      Math.max(retrieval.rerankTopK, RERANK_POOL_FLOOR),
    );
    const passages = pool.map((item) => buildModelPassage(item));
    // A failing or missing rerank model degrades to the retrieval order,
    // not a failed chat (the status records the outcome).
    let modelScores: number[] | null = null;
    let rerankStatus: RagRerankStatus;
    try {
      const result = await this.rerankPort.rerank(
        workspaceId,
        retrieval.rerankModel,
        input.query.trim(),
        passages,
      );
      rerankStatus = result.status === 'ok' ? 'applied' : result.status;
      modelScores = result.status === 'ok' ? result.scores : null;
    } catch {
      rerankStatus = 'failed';
      modelScores = null;
    }
    const stage = applyRerankStage({
      candidates: pool,
      modelScores,
      threshold: retrieval.rerankThreshold,
      topK: retrieval.rerankTopK,
      explicitScope: Boolean(input.spaceId),
    });
    return { evidence: stage.evidence, rerankStatus };
  }

  /**
   * Model rewrite (query_understand.go): temperature 0.3, 150-token budget,
   * the pinned default_rewrite output schema, and a fallback to the original
   * query on any failure. The intent and image_description fields are parsed
   * but unused in docmost's single-intent chat flow.
   */
  private async rewriteQuery(
    workspaceId: string,
    chat: RagChatRetrievalSettings,
    input: RagChatRetrievalInput,
  ): Promise<{ rewrittenQuery: string; applied: boolean }> {
    const provider = await this.readProvider(workspaceId);
    if (!provider?.apiKey) {
      return { rewrittenQuery: input.query.trim(), applied: false };
    }
    const model = chat.queryUnderstandingModel ?? provider.chatModel;
    const conversation = formatConversation(input.history ?? []);
    const systemPrompt = renderPlaceholders(chat.rewriteSystemPrompt, {
      conversation,
      language: 'English',
      current_time: new Date().toISOString(),
      current_week: `week ${isoWeek(new Date())}`,
      query: input.query.trim(),
    });
    const userPrompt = renderPlaceholders(chat.rewriteUserPrompt, {
      conversation,
      language: 'English',
      current_time: new Date().toISOString(),
      current_week: `week ${isoWeek(new Date())}`,
      query: buildMarkedQuery(input),
    });
    try {
      const content = await this.completeRewrite(
        provider,
        model,
        systemPrompt,
        userPrompt,
      );
      const parsed = parseRewriteOutput(content);
      if (!parsed) {
        return { rewrittenQuery: input.query.trim(), applied: false };
      }
      return { rewrittenQuery: parsed.rewriteQuery, applied: true };
    } catch {
      return { rewrittenQuery: input.query.trim(), applied: false };
    }
  }

  private async completeRewrite(
    provider: WorkspaceAiProvider,
    model: string,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string | null> {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    let body: unknown;
    if (provider.driver === 'ollama') {
      body = {
        model,
        messages,
        stream: false,
        options: {
          temperature: REWRITE_TEMPERATURE,
          num_predict: REWRITE_MAX_TOKENS,
        },
      };
    } else if (provider.driver === 'gemini') {
      body = {
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: REWRITE_TEMPERATURE,
          maxOutputTokens: REWRITE_MAX_TOKENS,
        },
      };
    } else {
      body = {
        model,
        messages,
        stream: false,
        temperature: REWRITE_TEMPERATURE,
        max_tokens: REWRITE_MAX_TOKENS,
      };
    }
    const url = chatUrlFor(provider, model);
    const lease = await this.outboundAgent.lease(url);
    try {
      const response = await request(url, {
        method: 'POST',
        signal: AbortSignal.timeout(this.environment.getAiRequestTimeoutMs()),
        dispatcher: lease.dispatcher,
        headers: providerHeadersFor(provider),
        body: JSON.stringify(body),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) return null;
      const result = (await response.body.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        message?: { content?: string };
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      return (
        result.choices?.[0]?.message?.content?.trim() ??
        result.message?.content?.trim() ??
        result.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? '')
          .join('')
          .trim() ??
        null
      );
    } finally {
      await lease.release();
    }
  }

  private async readProvider(workspaceId: string) {
    const row = await this.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    if (!row) return undefined;
    return readWorkspaceAiProvider(row, this.encryption);
  }

  private async readStoredSettings(
    workspaceId: string,
  ): Promise<{ retrievalSettings: unknown; chatRetrievalSettings: unknown }> {
    const row = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const rag = (row?.settings as Record<string, unknown> | null)?.['rag'] as
      | Record<string, unknown>
      | undefined;
    return {
      retrievalSettings: rag?.['retrievalSettings'],
      chatRetrievalSettings: rag?.['chatRetrievalSettings'],
    };
  }
}

/**
 * WeKnora's rewrite prompt expects the current message annotated with
 * attachment-presence markers; docmost chat has no image attachments, so the
 * image marker is always absent and document markers reflect the claimed
 * chat attachments by file name.
 */
function buildMarkedQuery(input: RagChatRetrievalInput): string {
  const lines = [input.query.trim()];
  lines.push('<no_image_attached />');
  if (input.attachmentFileNames?.length) {
    lines.push('<documents_attached>');
    for (const name of input.attachmentFileNames) {
      lines.push(name);
    }
    lines.push('</documents_attached>');
  } else {
    lines.push('<no_document_attached />');
  }
  return lines.join('\n');
}

function formatConversation(history: RagChatHistoryTurn[]): string {
  if (history.length === 0) return '(no conversation history)';
  return history
    .map(
      (turn) =>
        `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content ?? ''}`,
    )
    .join('\n');
}

function renderPlaceholders(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (match, name: string) =>
    name in values ? values[name] : match,
  );
}

function isoWeek(date: Date): number {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return (
    1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000)
  );
}

/** Deduplicates evidence by chunk keeping the higher score, order preserved. */
function mergeByChunk(
  base: RagEvidence[],
  incoming: RagEvidence[],
): RagEvidence[] {
  const best = new Map<string, RagEvidence>();
  for (const item of base) {
    const existing = best.get(item.chunkId);
    if (!existing || item.score.value > existing.score.value) {
      best.set(item.chunkId, item);
    }
  }
  for (const item of incoming) {
    const existing = best.get(item.chunkId);
    if (!existing || item.score.value > existing.score.value) {
      best.set(item.chunkId, item);
    }
  }
  return [...best.values()];
}
