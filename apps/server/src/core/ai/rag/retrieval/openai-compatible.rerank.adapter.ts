import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { OutboundAgentFactory } from '../../../../integrations/outbound/outbound-agent.factory';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import { RagRerankPort, RagRerankResult } from '../contracts';
import {
  readWorkspaceAiProvider,
  WorkspaceAiProvider,
} from '../embedding/provider-settings';

/**
 * OpenAI-compatible rerank port (docmost-rag-v1 contract 12). Sends the
 * standard `/v1/rerank` shape ({model, query, documents, top_n}) and expects
 * `{results: [{index, relevance_score}]}` back, using the rerank model name
 * from the owner-controlled retrieval settings and the workspace's existing
 * provider credentials (no separate rerank provider configuration).
 *
 * Outcomes are reported, not guessed: a missing provider/key is
 * `not_configured`, while a reached endpoint that fails, returns malformed
 * data, or does not cover every passage exactly once with a finite score is
 * `failed`. Zero-filling missing scores is forbidden: a partially covered
 * response must degrade to retrieval order with `failed` metadata, never
 * invent low relevance scores. Callers preserve retrieval order for both
 * non-ok outcomes. Credential values never appear in logs or errors.
 */
@Injectable()
export class OpenAiCompatibleRerankAdapter implements RagRerankPort {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly encryption: EncryptionService,
    private readonly outboundAgent: OutboundAgentFactory,
    private readonly environment: EnvironmentService,
  ) {}

  async rerank(
    workspaceId: string,
    model: string,
    query: string,
    passages: string[],
  ): Promise<RagRerankResult> {
    if (passages.length === 0) return { status: 'failed' };
    const provider = await this.readProvider(workspaceId);
    if (!provider?.apiKey) return { status: 'not_configured' };

    const url = new URL('/v1/rerank', provider.baseUrl).toString();
    try {
      const lease = await this.outboundAgent.lease(url);
      try {
        const response = await request(url, {
          method: 'POST',
          signal: AbortSignal.timeout(this.environment.getAiRequestTimeoutMs()),
          dispatcher: lease.dispatcher,
          headers: {
            authorization: `Bearer ${provider.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            query,
            documents: passages,
            top_n: passages.length,
          }),
        });
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return { status: 'failed' };
        }
        const result = (await response.body.json()) as {
          results?: Array<{ index?: unknown; relevance_score?: unknown }>;
        };
        const results = result.results;
        // Exact-one coverage is required: a partially covered or empty
        // response can never pass, so an indexed scan (not a hole-skipping
        // check) verifies every passage has exactly one finite score.
        if (!Array.isArray(results) || results.length !== passages.length) {
          return { status: 'failed' };
        }
        const scores = new Array<number | undefined>(passages.length).fill(
          undefined,
        );
        for (const entry of results) {
          const index = entry?.index;
          const score = entry?.relevance_score;
          if (
            typeof index !== 'number' ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= passages.length ||
            typeof score !== 'number' ||
            !Number.isFinite(score)
          ) {
            return { status: 'failed' };
          }
          if (scores[index] !== undefined) {
            return { status: 'failed' };
          }
          scores[index] = score;
        }
        for (let i = 0; i < passages.length; i += 1) {
          if (scores[i] === undefined) {
            return { status: 'failed' };
          }
        }
        return { status: 'ok', scores: scores as number[] };
      } finally {
        await lease.release();
      }
    } catch {
      return { status: 'failed' };
    }
  }

  private async readProvider(
    workspaceId: string,
  ): Promise<WorkspaceAiProvider | undefined> {
    const row = await this.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    if (!row) return undefined;
    return readWorkspaceAiProvider(row, this.encryption);
  }
}
