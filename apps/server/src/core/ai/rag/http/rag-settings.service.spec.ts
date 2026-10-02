import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { Workspace } from '@docmost/db/types/entity.types';
import {
  ragTestDbConfigured,
  seedWorkspace,
  withRagTestDb,
} from '../persistence/rag-test-db';
import { RagStateRepository } from '../persistence/rag-state.repository';
import { RagSettingsService } from './rag-settings.service';
import {
  FixtureProfileValidator,
  makeUser,
  seedUser,
} from '../retrieval/rag-test-support';
import { IndexProfileConfig } from '../contracts';

const VALID_CONFIG: IndexProfileConfig = {
  parserVersion: 'parser-1',
  chunkerVersion: 'chunker-1',
  maxChunkTokens: 512,
  overlapTokens: 64,
  sourcePolicy: {
    requiredMimeTypes: ['text/plain'],
    imageInterpretation: 'disabled',
  },
  embedding: {
    driver: 'openai-compatible',
    endpointIdentity: null,
    model: 'test-embedding-model',
    dimensions: 1536,
    tokenizerId: null,
    maxInputTokens: 8192,
  },
};

// Per-test DB provisioning exceeds the default 5s timeout on cold starts.
jest.setTimeout(30000);

(ragTestDbConfigured ? describe : describe.skip)('RagSettingsService', () => {
  const setup = async (
    run: (ctx: {
      db: Kysely<DbInterface>;
      workspaceId: string;
      ownerId: string;
      service: RagSettingsService;
    }) => Promise<void>,
  ): Promise<void> => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const ownerId = randomUUID();
      await seedUser(db, makeUser(workspaceId, ownerId));
      const service = new RagSettingsService(
        db,
        new RagStateRepository(db),
        new FixtureProfileValidator(),
      );
      await run({ db, workspaceId, ownerId, service });
    });
  };

  it('returns an unconfigured view before any update', async () => {
    await setup(async ({ db, workspaceId, service }) => {
      await expect(
        service.getSettings({ id: workspaceId } as never),
      ).resolves.toEqual({ enabled: false, indexProfile: null });

      // A row without a stored config still yields a null profile.
      await db.transaction().execute((trx) =>
        new RagStateRepository(db).updateWorkspaceProfile(trx, workspaceId, {
          enabled: true,
          profileId: '0f0a3c1e-8b2d-4c6e-9a70-d1e2f3a4b5c6',
          profileHash: 'hash-1',
        }),
      );
      await expect(
        service.getSettings({ id: workspaceId } as never),
      ).resolves.toEqual({ enabled: true, indexProfile: null });
    });
  });

  it('persists the config in owner settings and the profile identity in state', async () => {
    await setup(async ({ db, workspaceId, service }) => {
      const view = await service.updateSettings({ id: workspaceId } as never, {
        enabled: true,
        indexProfileConfig: VALID_CONFIG,
      });
      expect(view.enabled).toBe(true);
      expect(view.indexProfile?.profileHash).toBe(
        new FixtureProfileValidator().validate({} as Workspace, VALID_CONFIG)
          .profileHash,
      );

      const stored = await service.getSettings({ id: workspaceId } as never);
      expect(stored).toEqual(view);

      const workspaceRow = await db
        .selectFrom('workspaces')
        .select('settings')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      expect(
        (workspaceRow?.settings as Record<string, never>)['rag'],
      ).toBeDefined();

      const profileRow = await db
        .selectFrom('ragWorkspaceProfile')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      expect(profileRow?.enabled).toBe(true);
      expect(profileRow?.profileHash).toBe(view.indexProfile?.profileHash);
    });
  });

  it('preserves unrelated owner settings keys when updating', async () => {
    await setup(async ({ db, workspaceId, service }) => {
      await db
        .updateTable('workspaces')
        .set({ settings: { keepMe: { nested: 1 } } as never })
        .where('id', '=', workspaceId)
        .execute();

      await service.updateSettings({ id: workspaceId } as never, {
        enabled: true,
        indexProfileConfig: VALID_CONFIG,
      });

      const row = await db
        .selectFrom('workspaces')
        .select('settings')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      const settings = row?.settings as Record<string, unknown>;
      expect(settings['keepMe']).toEqual({ nested: 1 });
      expect(settings['rag']).toBeDefined();
    });
  });

  it('persists nothing when the validator rejects the config', async () => {
    await setup(async ({ db, workspaceId, service }) => {
      const unsupported: IndexProfileConfig = {
        ...VALID_CONFIG,
        embedding: { ...VALID_CONFIG.embedding, driver: 'unknown-driver' },
      };

      await expect(
        service.updateSettings({ id: workspaceId } as never, {
          enabled: true,
          indexProfileConfig: unsupported,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      const profileRow = await db
        .selectFrom('ragWorkspaceProfile')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      expect(profileRow).toBeUndefined();

      const row = await db
        .selectFrom('workspaces')
        .select('settings')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      expect(row?.settings ?? null).toBeNull();
    });
  });

  it('reports a disabled workspace while keeping the configured profile', async () => {
    await setup(async ({ workspaceId, service }) => {
      await service.updateSettings({ id: workspaceId } as never, {
        enabled: false,
        indexProfileConfig: VALID_CONFIG,
      });
      const view = await service.getSettings({ id: workspaceId } as never);
      expect(view.enabled).toBe(false);
      expect(view.indexProfile).not.toBeNull();
    });
  });

  it('persists the validator-normalized config the profile hash was computed over', async () => {
    await setup(async ({ db, workspaceId }) => {
      class NormalizingValidator extends FixtureProfileValidator {
        validate(
          workspace: Workspace,
          config: IndexProfileConfig,
        ): ReturnType<FixtureProfileValidator['validate']> {
          return super.validate(workspace, {
            ...config,
            parserVersion: 'normalized-parser',
          });
        }
      }
      const service = new RagSettingsService(
        db,
        new RagStateRepository(db),
        new NormalizingValidator(),
      );

      const view = await service.updateSettings({ id: workspaceId } as never, {
        enabled: true,
        indexProfileConfig: VALID_CONFIG,
      });

      const row = await db
        .selectFrom('workspaces')
        .select('settings')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      const stored = (
        (row?.settings as Record<string, never>)['rag'] as {
          indexProfileConfig: IndexProfileConfig;
        }
      ).indexProfileConfig;
      expect(stored.parserVersion).toBe('normalized-parser');
      // The stored config is byte-identical to the hashed config: re-hashing
      // it reproduces the persisted profile identity.
      expect(
        new FixtureProfileValidator().validate({} as Workspace, stored)
          .profileHash,
      ).toBe(view.indexProfile?.profileHash);
    });
  });
});
