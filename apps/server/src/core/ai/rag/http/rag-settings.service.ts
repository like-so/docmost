import { Inject, Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { Workspace } from '@docmost/db/types/entity.types';
import { JsonObject, JsonValue } from '@docmost/db/types/db';
import {
  IndexProfile,
  IndexProfileConfig,
  RagError,
  RagRetrievalSettingsView,
  RagSettingsView,
} from '../contracts';
import {
  parseChatRetrievalSettings,
  parseRetrievalSettings,
} from '../retrieval/retrieval-config';
import { RagStateRepository } from '../persistence/rag-state.repository';
import {
  RagProfileConfigValidator,
  RAG_PROFILE_CONFIG_VALIDATOR,
} from './rag-profile-validator';

/** Owner-controlled settings key holding the RAG index profile config. */
const RAG_SETTINGS_KEY = 'rag';
const RAG_RETRIEVAL_SETTINGS_KEY = 'retrievalSettings';
const RAG_CHAT_RETRIEVAL_SETTINGS_KEY = 'chatRetrievalSettings';

/** Converts the profile config to the workspace settings JSON boundary. */
function toStoredIndexProfileConfig(config: IndexProfileConfig): JsonObject {
  return {
    parserVersion: config.parserVersion,
    chunkerVersion: config.chunkerVersion,
    maxChunkTokens: config.maxChunkTokens,
    overlapTokens: config.overlapTokens,
    sourcePolicy: {
      requiredMimeTypes: [...config.sourcePolicy.requiredMimeTypes],
      imageInterpretation: config.sourcePolicy.imageInterpretation,
    },
    embedding: {
      driver: config.embedding.driver,
      endpointIdentity: config.embedding.endpointIdentity,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      tokenizerId: config.embedding.tokenizerId,
      maxInputTokens: config.embedding.maxInputTokens,
    },
    // indexingStrategy must round-trip: dropping it here made keyword-only
    // profiles read back as vector-enabled and re-enable the vector channel.
    ...(config.indexingStrategy
      ? {
          indexingStrategy: {
            vectorEnabled: config.indexingStrategy.vectorEnabled,
            keywordEnabled: config.indexingStrategy.keywordEnabled,
          },
        }
      : {}),
  };
}

/**
 * Workspace-owner RAG settings adapter (docmost-rag-v1 contract 13). The full
 * index profile config is stored under the owner-controlled workspace
 * settings; the resolved profile identity (profileId/profileHash) is persisted
 * through the foundation state repository. Profile rebuild scheduling belongs
 * to orchestration, not to this adapter.
 */
@Injectable()
export class RagSettingsService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly stateRepository: RagStateRepository,
    @Inject(RAG_PROFILE_CONFIG_VALIDATOR)
    private readonly profileValidator: RagProfileConfigValidator,
  ) {}

  async getSettings(workspace: Workspace): Promise<RagSettingsView> {
    const row = await this.stateRepository.findWorkspaceProfile(
      this.db,
      workspace.id,
    );
    if (!row?.profileId || !row.profileHash) {
      return { enabled: false, indexProfile: null };
    }
    const config = await this.readStoredConfig(workspace.id);
    if (!config) {
      return { enabled: row.enabled, indexProfile: null };
    }
    return {
      enabled: row.enabled,
      indexProfile: {
        ...config,
        profileId: row.profileId,
        profileHash: row.profileHash,
      },
    };
  }

  async updateSettings(
    workspace: Workspace,
    input: {
      enabled: boolean;
      indexProfileConfig: IndexProfileConfig;
    },
  ): Promise<RagSettingsView> {
    let profile: IndexProfile;
    try {
      profile = this.profileValidator.validate(
        workspace,
        input.indexProfileConfig,
      );
    } catch (error) {
      if (error instanceof RagError) {
        // Redacted: the error code only, never credential or source text.
        throw new BadRequestException(error.code);
      }
      throw error;
    }

    await this.db.transaction().execute(async (trx) => {
      // Persist the validator's normalized profile so the stored config is
      // byte-identical to the config the profile hash was computed over.
      await this.persistConfig(trx, workspace.id, profile);
      await this.stateRepository.updateWorkspaceProfile(trx, workspace.id, {
        enabled: input.enabled,
        profileId: profile.profileId,
        profileHash: profile.profileHash,
      });
    });

    return { enabled: input.enabled, indexProfile: profile };
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
      RAG_SETTINGS_KEY
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

  private async persistConfig(
    trx: KyselyTransaction,
    workspaceId: string,
    config: IndexProfileConfig,
  ): Promise<void> {
    await trx
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirst();
    const row = await trx
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const settings = (row?.settings ?? {}) as JsonObject;
    const existingRagConfig = (settings[RAG_SETTINGS_KEY] ?? {}) as JsonObject;
    const merged: JsonObject = {
      ...settings,
      [RAG_SETTINGS_KEY]: {
        ...existingRagConfig,
        indexProfileConfig: toStoredIndexProfileConfig(config),
      },
    };
    await trx
      .updateTable('workspaces')
      .set({ settings: merged })
      .where('id', '=', workspaceId)
      .execute();
  }

  /**
   * Owner-only retrieval settings view: current values normalized through the
   * same clamping used at retrieval time, plus the pinned default prompt.
   */
  async getRetrievalSettings(
    workspace: Workspace,
  ): Promise<RagRetrievalSettingsView> {
    const stored = this.readRetrievalSettings(workspace);
    const search = parseRetrievalSettings(stored.retrievalSettings);
    const chat = parseChatRetrievalSettings(stored.chatRetrievalSettings);
    return { search, chat };
  }

  /**
   * Partial owner-only retrieval settings update. Every field is optional;
   * the merged payload is normalized (defaults and clamping) before it is
   * persisted, and the normalized values are returned.
   */
  async updateRetrievalSettings(
    workspace: Workspace,
    input: {
      search?: Record<string, unknown> | null;
      chat?: Record<string, unknown> | null;
    },
  ): Promise<RagRetrievalSettingsView> {
    const workspaceId = workspace.id;
    return this.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .forUpdate()
        .executeTakeFirst();
      const row = await trx
        .selectFrom('workspaces')
        .select('settings')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      const settings = (row?.settings ?? {}) as JsonObject;
      const existingRagConfig = (settings[RAG_SETTINGS_KEY] ??
        {}) as JsonObject;
      const current = this.readRetrievalSettings({
        settings: settings as Workspace['settings'],
      } as Workspace);
      const nextRetrieval = parseRetrievalSettings({
        ...(current.retrievalSettings as Record<string, unknown> | null),
        ...(input.search ?? {}),
      });
      const nextChat = parseChatRetrievalSettings({
        ...(current.chatRetrievalSettings as Record<string, unknown> | null),
        ...(input.chat ?? {}),
      });
      const merged: JsonObject = {
        ...settings,
        [RAG_SETTINGS_KEY]: {
          ...existingRagConfig,
          [RAG_RETRIEVAL_SETTINGS_KEY]: nextRetrieval as unknown as JsonValue,
          [RAG_CHAT_RETRIEVAL_SETTINGS_KEY]: nextChat as unknown as JsonValue,
        },
      };
      await trx
        .updateTable('workspaces')
        .set({ settings: merged })
        .where('id', '=', workspaceId)
        .execute();
      return { search: nextRetrieval, chat: nextChat };
    });
  }

  private readRetrievalSettings(workspace: Workspace): {
    retrievalSettings: unknown;
    chatRetrievalSettings: unknown;
  } {
    const rag = (workspace.settings as Record<string, unknown> | null)?.[
      RAG_SETTINGS_KEY
    ] as Record<string, unknown> | undefined;
    return {
      retrievalSettings: rag?.[RAG_RETRIEVAL_SETTINGS_KEY],
      chatRetrievalSettings: rag?.[RAG_CHAT_RETRIEVAL_SETTINGS_KEY],
    };
  }
}
