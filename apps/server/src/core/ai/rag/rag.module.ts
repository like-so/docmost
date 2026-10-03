import { Global, Injectable, Module } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Workspace } from '@docmost/db/types/entity.types';
import {
  IndexProfile,
  IndexProfileConfig,
  RagError,
  RagProfileResolver,
} from './contracts';
import { computeProfileHash, computeProfileId } from './embedding/profile-hash';
import {
  readWorkspaceAiProvider,
  providerSettingsIdentity,
} from './embedding/provider-settings';
import { EncryptionService } from '../../../integrations/encryption/encryption.service';
import { OpenAiCompatibleEmbeddingAdapter } from './embedding/openai-compatible.embedding.adapter';
import {
  RagProfileConfigValidator,
  RAG_PROFILE_CONFIG_VALIDATOR,
} from './http/rag-profile-validator';
import { RagHttpModule } from './http/http.module';
import { RagChunkingModule } from './chunking/chunking.module';
import { RagParsingModule } from './parsing/parsing.module';
import { RagPersistenceModule } from './persistence/persistence.module';
import { RagSourceModule } from './source/source.module';
import { RagStateRepository } from './persistence/rag-state.repository';
import { RagGenerationStore } from './index-store/rag-generation.store';
import {
  RAG_EMBEDDING_PORT,
  RAG_GENERATION_STORE,
  RAG_INDEXER,
  RAG_PROFILE_RESOLVER,
  RAG_RERANK_PORT,
} from './contracts';
import { RagIndexerService } from './rag-indexer.service';
import { RagProcessor } from './rag.processor';
import { RagOutboxRelayService } from './rag-outbox-relay.service';
import { RagRetrieverService } from './retrieval/rag-retriever.service';
import { RagChatRetrievalService } from './retrieval/rag-chat-retrieval.service';
import { OpenAiCompatibleRerankAdapter } from './retrieval/openai-compatible.rerank.adapter';
import { RagEvidenceGate } from './retrieval/rag-evidence-gate';

/**
 * Wiring-level profile adapter (docmost-rag-v1 contract 13). The HTTP
 * settings writer needs a synchronous validator; the embedding component's
 * resolver validates asynchronously against stored settings, so this adapter
 * applies the contract 8 shape rules and derives the deterministic profile
 * identity with the embedding component's own hash functions. The
 * endpointIdentity is always derived server-side from the workspace's
 * authoritative encrypted provider settings; any client-supplied value is
 * ignored, so the persisted config and the profile hash both carry the same
 * normalized identity the embedding adapter re-derives at embed time.
 */
@Injectable()
export class RagComposedProfileValidator implements RagProfileConfigValidator {
  constructor(private readonly encryption: EncryptionService) {}

  validate(workspace: Workspace, config: IndexProfileConfig): IndexProfile {
    if (config.embedding.driver !== 'openai-compatible') {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        `embedding driver "${config.embedding.driver}" is not supported; configure openai-compatible`,
      );
    }
    const embedding = config.embedding;
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
      typeof config.parserVersion !== 'string' ||
      !config.parserVersion ||
      typeof config.chunkerVersion !== 'string' ||
      !config.chunkerVersion
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'parserVersion and chunkerVersion are required',
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
    const sourcePolicy = config.sourcePolicy;
    if (
      !Array.isArray(sourcePolicy?.requiredMimeTypes) ||
      sourcePolicy.requiredMimeTypes.some(
        (mimeType) => typeof mimeType !== 'string' || !mimeType,
      ) ||
      (sourcePolicy.imageInterpretation !== 'disabled' &&
        sourcePolicy.imageInterpretation !== 'required')
    ) {
      throw new RagError('EMBEDDING_NOT_CONFIGURED', 'sourcePolicy is invalid');
    }
    if (
      config.indexingStrategy !== undefined &&
      (typeof config.indexingStrategy !== 'object' ||
        config.indexingStrategy === null ||
        typeof config.indexingStrategy.vectorEnabled !== 'boolean' ||
        typeof config.indexingStrategy.keywordEnabled !== 'boolean')
    ) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'indexingStrategy must contain boolean vectorEnabled and keywordEnabled',
      );
    }

    const provider = readWorkspaceAiProvider(workspace, this.encryption);
    if (!provider) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'workspace AI provider settings are required for the embedding endpoint',
      );
    }
    // The client-supplied endpointIdentity is never trusted: the normalized
    // config below is the exact object the profile hash is computed over.
    const normalized: IndexProfileConfig = {
      ...config,
      embedding: {
        ...embedding,
        endpointIdentity: providerSettingsIdentity(provider),
      },
    };
    const profileHash = computeProfileHash(normalized);
    return {
      ...normalized,
      profileId: computeProfileId(profileHash),
      profileHash,
    };
  }
}

/**
 * Wiring-level resolver bridge. The embedding component's resolver reads the
 * enabled flag from workspace settings JSON, while the accepted HTTP settings
 * writer persists the authoritative enabled flag and profile identity in
 * rag_workspace_profile (contract 13). This adapter composes both: enabled
 * and identity come from the durable state machine, the config from the
 * owner-controlled settings, and the identity is verified against a fresh
 * hash of the stored config so a drifted pair fails explicitly instead of
 * mixing embeddings across profiles.
 */
@Injectable()
export class RagComposedProfileResolver implements RagProfileResolver {
  constructor(
    private readonly stateRepository: RagStateRepository,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async resolve(workspaceId: string): Promise<IndexProfile> {
    const row = await this.stateRepository.findWorkspaceProfile(
      this.db,
      workspaceId,
    );
    if (!row?.enabled || !row.profileId || !row.profileHash) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'RAG indexing is not configured for this workspace',
      );
    }
    const config = await this.readStoredConfig(workspaceId);
    if (!config) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'RAG index profile config is missing from workspace settings',
      );
    }
    const profileHash = computeProfileHash(config);
    if (profileHash !== row.profileHash) {
      throw new RagError(
        'EMBEDDING_NOT_CONFIGURED',
        'persisted profile identity does not match the stored config',
      );
    }
    return {
      ...config,
      profileId: row.profileId,
      profileHash: row.profileHash,
    };
  }

  private async readStoredConfig(
    workspaceId: string,
  ): Promise<IndexProfileConfig | null> {
    const row = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const stored = (row?.settings as Record<string, unknown> | null)?.[
      'rag'
    ] as { indexProfileConfig?: IndexProfileConfig } | undefined;
    const config = stored?.indexProfileConfig;
    if (
      typeof config !== 'object' ||
      config === null ||
      typeof config.embedding !== 'object' ||
      config.embedding === null ||
      typeof config.sourcePolicy !== 'object' ||
      config.sourcePolicy === null
    ) {
      return null;
    }
    return config;
  }
}

/**
 * Assembles the accepted RAG components into the existing application: the
 * persistence, source, parsing, chunking and HTTP modules, the index store,
 * the asynchronous worker and the durable outbox relay on the dedicated RAG
 * queue registration (QueueModule is global).
 *
 * The module is global because the HTTP and retrieval components were
 * accepted unwired: RagSettingsService expects RAG_PROFILE_CONFIG_VALIDATOR
 * and RagRetrieverService expects RAG_PROFILE_RESOLVER and
 * RAG_EMBEDDING_PORT from the orchestration layer rather than from their own
 * module imports. The resolver binding is the composition bridge above; the
 * embedding port is the accepted OpenAI-compatible adapter.
 */
@Global()
@Module({
  imports: [
    RagPersistenceModule,
    RagSourceModule,
    RagParsingModule,
    RagChunkingModule,
    RagHttpModule,
  ],
  providers: [
    OpenAiCompatibleEmbeddingAdapter,
    {
      provide: RAG_EMBEDDING_PORT,
      useExisting: OpenAiCompatibleEmbeddingAdapter,
    },
    RagComposedProfileValidator,
    {
      provide: RAG_PROFILE_CONFIG_VALIDATOR,
      useExisting: RagComposedProfileValidator,
    },
    RagComposedProfileResolver,
    { provide: RAG_PROFILE_RESOLVER, useExisting: RagComposedProfileResolver },
    RagGenerationStore,
    { provide: RAG_GENERATION_STORE, useExisting: RagGenerationStore },
    RagIndexerService,
    { provide: RAG_INDEXER, useExisting: RagIndexerService },
    RagProcessor,
    RagOutboxRelayService,
    OpenAiCompatibleRerankAdapter,
    { provide: RAG_RERANK_PORT, useExisting: OpenAiCompatibleRerankAdapter },
    RagEvidenceGate,
    RagRetrieverService,
    RagChatRetrievalService,
  ],
  exports: [
    RagIndexerService,
    RAG_INDEXER,
    RAG_PROFILE_CONFIG_VALIDATOR,
    RAG_PROFILE_RESOLVER,
    RAG_EMBEDDING_PORT,
    RAG_RERANK_PORT,
    RagEvidenceGate,
    RagRetrieverService,
    RagChatRetrievalService,
  ],
})
export class RagModule {}
