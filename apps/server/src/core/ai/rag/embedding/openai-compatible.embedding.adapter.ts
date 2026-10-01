import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import {
  EmbeddingBatchResult,
  EmbeddingInput,
  EmbeddingQueryResult,
  EmbeddingPort,
  IndexProfile,
  RagError,
  RAG_EMBEDDING_PORT,
} from '../contracts';
import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import { OutboundAgentFactory } from '../../../../integrations/outbound/outbound-agent.factory';
import { readWorkspaceAiProvider } from './provider-settings';

const SUPPORTED_EMBEDDING_DRIVER = 'openai-compatible';

/** HTTP status classes for embedding endpoint responses. */
const CONFIGURATION_STATUSES = new Set([401, 403, 404]);
const TRANSIENT_STATUSES = new Set([408, 409, 429]);

const NETWORK_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

type EmbeddingsResponseBody = {
  data?: Array<{ index?: unknown; embedding?: unknown }>;
  model?: unknown;
};

/**
 * OpenAI-compatible embeddings driver (docmost-rag-v1 contract 8). Talks to
 * the existing encrypted workspace provider settings through the shared
 * outbound factory so SSRF guards, TLS and network restrictions apply.
 * Missing capability is explicit: no hash vectors, public endpoints, random
 * values or chat-model substitution.
 */
@Injectable()
export class OpenAiCompatibleEmbeddingAdapter implements EmbeddingPort {
  constructor(
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly encryption: EncryptionService,
    private readonly outboundAgent: OutboundAgentFactory,
    private readonly environment: EnvironmentService,
  ) {}

  async embed(
    workspaceId: string,
    indexProfile: IndexProfile,
    inputs: EmbeddingInput[],
  ): Promise<EmbeddingBatchResult> {
    if (inputs.length === 0) {
      return {
        profileHash: indexProfile.profileHash,
        dimensions: indexProfile.embedding.dimensions,
        vectors: [],
      };
    }
    const vectors = await this.requestEmbeddings(
      workspaceId,
      indexProfile,
      inputs,
    );
    return {
      profileHash: indexProfile.profileHash,
      dimensions: indexProfile.embedding.dimensions,
      vectors,
    };
  }

  async embedQuery(
    workspaceId: string,
    indexProfile: IndexProfile,
    query: string,
  ): Promise<EmbeddingQueryResult> {
    if (!query.trim()) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'query must not be empty',
      );
    }
    const [vector] = await this.requestEmbeddings(workspaceId, indexProfile, [
      { chunkId: 'query', text: query },
    ]);
    return {
      profileHash: indexProfile.profileHash,
      dimensions: indexProfile.embedding.dimensions,
      values: vector.values,
    };
  }

  private async requestEmbeddings(
    workspaceId: string,
    indexProfile: IndexProfile,
    inputs: EmbeddingInput[],
  ) {
    if (indexProfile.embedding.driver !== SUPPORTED_EMBEDDING_DRIVER) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        `embedding driver "${indexProfile.embedding.driver}" is not supported; configure ${SUPPORTED_EMBEDDING_DRIVER}`,
      );
    }
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const provider = readWorkspaceAiProvider(workspace, this.encryption);
    if (!provider) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'workspace AI provider settings are not configured',
      );
    }

    let url: URL;
    try {
      url = new URL('/v1/embeddings', provider.baseUrl);
    } catch {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'workspace AI provider base URL is invalid',
      );
    }

    const body = JSON.stringify({
      model: indexProfile.embedding.model,
      input: inputs.map((input) => input.text),
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (provider.apiKey) {
      headers.authorization = `Bearer ${provider.apiKey}`;
    }

    let response;
    const lease = await this.outboundAgent.lease(url.toString());
    try {
      response = await request(url, {
        method: 'POST',
        dispatcher: lease.dispatcher,
        headers,
        body,
        signal: AbortSignal.timeout(this.environment.getAiRequestTimeoutMs()),
      });
    } catch (error) {
      throw this.classifyRequestError(error);
    } finally {
      await lease.release();
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      this.discardBody(response);
      throw this.classifyStatusError(response.statusCode);
    }

    let responseBody: EmbeddingsResponseBody;
    try {
      responseBody = (await response.body.json()) as EmbeddingsResponseBody;
    } catch {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'embedding endpoint returned a non-JSON response',
      );
    } finally {
      this.discardBody(response);
    }

    return this.mapResponse(indexProfile, inputs, responseBody);
  }

  private mapResponse(
    indexProfile: IndexProfile,
    inputs: EmbeddingInput[],
    responseBody: EmbeddingsResponseBody,
  ) {
    if (
      typeof responseBody.model === 'string' &&
      responseBody.model !== indexProfile.embedding.model
    ) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'embedding response model does not match the index profile',
      );
    }
    const data = responseBody.data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'embedding response cardinality does not match the request',
      );
    }

    const dimensions = indexProfile.embedding.dimensions;
    const vectors: EmbeddingBatchResult['vectors'] = new Array(inputs.length);
    const seen = new Set<number>();
    for (const entry of data) {
      const index = entry?.index;
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= inputs.length ||
        seen.has(index as number)
      ) {
        throw new RagError(
          'EMBEDDING_RESPONSE_INVALID',
          'embedding response order is incomplete or duplicated',
        );
      }
      seen.add(index as number);
      const values = this.validateVector(entry?.embedding, dimensions);
      vectors[index as number] = {
        chunkId: inputs[index as number].chunkId,
        values,
      };
    }
    if (seen.size !== inputs.length) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'embedding response is incomplete',
      );
    }
    return vectors;
  }

  private validateVector(embedding: unknown, dimensions: number): number[] {
    if (
      !Array.isArray(embedding) ||
      embedding.length !== dimensions ||
      !embedding.every((value) => Number.isFinite(value))
    ) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'embedding response vectors do not match the profile dimensions or are not finite',
      );
    }
    const values = embedding as number[];
    if (values.every((value) => value === 0)) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'embedding response vector is all zeros',
      );
    }
    return values;
  }

  private classifyRequestError(error: unknown): RagError {
    if (error instanceof RagError) return error;
    const named = error as { name?: string; code?: string };
    if (
      NETWORK_ERROR_NAMES.has(named?.name ?? '') ||
      NETWORK_ERROR_CODES.has(named?.code ?? '')
    ) {
      return new RagError(
        'EMBEDDING_UNAVAILABLE',
        'embedding endpoint is unavailable',
      );
    }
    return new RagError('EMBEDDING_UNAVAILABLE', 'embedding request failed');
  }

  private classifyStatusError(statusCode: number): RagError {
    if (CONFIGURATION_STATUSES.has(statusCode)) {
      return new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        `embedding endpoint rejected the request (HTTP ${statusCode})`,
      );
    }
    if (TRANSIENT_STATUSES.has(statusCode) || statusCode >= 500) {
      return new RagError(
        'EMBEDDING_UNAVAILABLE',
        `embedding endpoint is unavailable (HTTP ${statusCode})`,
      );
    }
    return new RagError(
      'EMBEDDING_RESPONSE_INVALID',
      `embedding endpoint rejected the request (HTTP ${statusCode})`,
    );
  }

  private discardBody(response: { body?: { destroy?: () => void } }) {
    response?.body?.destroy?.();
  }
}

export const RAG_EMBEDDING_PORT_PROVIDER = {
  provide: RAG_EMBEDDING_PORT,
  useExisting: OpenAiCompatibleEmbeddingAdapter,
};
