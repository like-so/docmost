import { Inject, Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { Workspace } from '@docmost/db/types/entity.types';
import { JsonObject } from '@docmost/db/types/db';
import {
  IndexProfile,
  IndexProfileConfig,
  RagError,
  RagSettingsView,
} from '../contracts';
import { RagStateRepository } from '../persistence/rag-state.repository';
import {
  RagProfileConfigValidator,
  RAG_PROFILE_CONFIG_VALIDATOR,
} from './rag-profile-validator';

/** Owner-controlled settings key holding the RAG index profile config. */
const RAG_SETTINGS_KEY = 'rag';

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
    input: { enabled: boolean; indexProfileConfig: IndexProfileConfig },
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
}
