import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { OutboundAgentFactory } from '../../../../integrations/outbound/outbound-agent.factory';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import { RagRerankPort } from '../contracts';
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
 * Any failure to reach or parse the endpoint yields null: callers preserve
 * retrieval order (reference NoModel outcome), so a broken reranker degrades
 * ranking quality but never blocks retrieval. Credential values never appear
 * in logs or errors.
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
  ): Promise<number[] | null> {
    if (passages.length === 0) return null;
    const provider = await this.readProvider(workspaceId);
    if (!provider?.apiKey) return null;

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
          return null;
        }
        const result = (await response.body.json()) as {
          results?: Array<{ index?: unknown; relevance_score?: unknown }>;
        };
        const results = result.results;
        if (!Array.isArray(results)) return null;
        const scores = new Array<number>(passages.length).fill(0);
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
            continue;
          }
          scores[index] = score;
        }
        return scores;
      } finally {
        await lease.release();
      }
    } catch {
      return null;
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
