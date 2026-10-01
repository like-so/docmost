import { Injectable } from '@nestjs/common';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Workspace } from '@docmost/db/types/entity.types';
import {
  EmbeddingProfileConfig,
  IndexProfile,
  IndexProfileConfig,
  RagError,
  RagProfileResolver,
  RAG_PROFILE_RESOLVER,
} from '../contracts';
import { computeProfileHash, computeProfileId } from './profile-hash';

/**
 * Owner-controlled RAG profile storage. The HTTP component (docmost-rag-v1
 * contract 13) writes this shape; this resolver only reads it. It contains
 * computation parameters and the identity of existing encrypted provider
 * settings, never credentials.
 */
interface RagWorkspaceSettings {
  enabled?: boolean;
  indexProfileConfig?: IndexProfileConfig;
}

const SUPPORTED_EMBEDDING_DRIVER = 'openai-compatible';

@Injectable()
export class RagProfileResolverService implements RagProfileResolver {
  constructor(private readonly workspaceRepo: WorkspaceRepo) {}

  async resolve(workspaceId: string): Promise<IndexProfile> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const settings = this.readRagSettings(workspace);
    if (!settings?.enabled || !settings.indexProfileConfig) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'RAG indexing is not configured for this workspace',
      );
    }
    const config = this.validateConfig(settings.indexProfileConfig);
    const profileHash = computeProfileHash(config);
    return {
      ...config,
      profileId: computeProfileId(profileHash),
      profileHash,
    };
  }

  private readRagSettings(workspace: Workspace): RagWorkspaceSettings | null {
    const settings = workspace.settings as {
      rag?: RagWorkspaceSettings;
    } | null;
    return settings?.rag ?? null;
  }

  private validateConfig(config: IndexProfileConfig): IndexProfileConfig {
    if (config.embedding.driver !== SUPPORTED_EMBEDDING_DRIVER) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        `embedding driver "${config.embedding.driver}" is not supported; configure ${SUPPORTED_EMBEDDING_DRIVER}`,
      );
    }
    this.validateEmbedding(config.embedding);
    if (typeof config.parserVersion !== 'string' || !config.parserVersion) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'parserVersion is required',
      );
    }
    if (typeof config.chunkerVersion !== 'string' || !config.chunkerVersion) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'chunkerVersion is required',
      );
    }
    if (
      !Number.isSafeInteger(config.maxChunkTokens) ||
      config.maxChunkTokens <= 0
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'maxChunkTokens must be a positive integer',
      );
    }
    if (
      !Number.isSafeInteger(config.overlapTokens) ||
      config.overlapTokens < 0 ||
      config.overlapTokens >= config.maxChunkTokens
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'overlapTokens must satisfy 0 <= overlapTokens < maxChunkTokens',
      );
    }
    this.validateSourcePolicy(config.sourcePolicy);
    return config;
  }

  private validateEmbedding(embedding: EmbeddingProfileConfig) {
    if (typeof embedding.model !== 'string' || !embedding.model.trim()) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'embedding model is required',
      );
    }
    if (
      !Number.isSafeInteger(embedding.dimensions) ||
      embedding.dimensions <= 0
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'embedding dimensions must be a positive integer; never guessed',
      );
    }
    if (
      !Number.isSafeInteger(embedding.maxInputTokens) ||
      embedding.maxInputTokens <= 0
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'embedding maxInputTokens must be a positive integer; never guessed',
      );
    }
    if (
      embedding.tokenizerId !== null &&
      (typeof embedding.tokenizerId !== 'string' || !embedding.tokenizerId)
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'embedding tokenizerId must be a nonempty string or null',
      );
    }
    if (
      embedding.endpointIdentity !== null &&
      (typeof embedding.endpointIdentity !== 'string' ||
        !embedding.endpointIdentity)
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'embedding endpointIdentity must be a nonempty string or null',
      );
    }
  }

  private validateSourcePolicy(
    sourcePolicy: IndexProfileConfig['sourcePolicy'],
  ) {
    if (
      !Array.isArray(sourcePolicy.requiredMimeTypes) ||
      sourcePolicy.requiredMimeTypes.some(
        (mimeType) => typeof mimeType !== 'string' || !mimeType,
      )
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'sourcePolicy.requiredMimeTypes must be a list of MIME type strings',
      );
    }
    if (
      sourcePolicy.imageInterpretation !== 'disabled' &&
      sourcePolicy.imageInterpretation !== 'required'
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'sourcePolicy.imageInterpretation must be "disabled" or "required"',
      );
    }
  }
}

export const RAG_PROFILE_RESOLVER_PROVIDER = {
  provide: RAG_PROFILE_RESOLVER,
  useExisting: RagProfileResolverService,
};
