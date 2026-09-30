import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { toInputRevision } from '../contracts';
import { RagStateRepository } from './rag-state.repository';
import {
  countRows,
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from './rag-test-db';

(ragTestDbConfigured ? describe : describe.skip)('RagStateRepository', () => {
  const setup = async (
    run: (
      db: Kysely<DbInterface>,
      repo: RagStateRepository,
      key: {
        workspaceId: string;
        pageId: string;
      },
    ) => Promise<void>,
  ) => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const key = { workspaceId, pageId: randomUUID() };
      await seedPage(db, workspaceId, key.pageId);
      const repo = new RagStateRepository(db);
      await run(db, repo, key);
    });
  };

  const advance = async (
    db: Kysely<DbInterface>,
    repo: RagStateRepository,
    key: { workspaceId: string; pageId: string },
    operation: 'upsert' | 'delete',
    cause: 'page' | 'restore',
  ) => {
    return db
      .transaction()
      .execute((trx) => repo.advanceForChange(trx, key, operation, cause));
  };

  const enableProfile = async (
    db: Kysely<DbInterface>,
    repo: RagStateRepository,
    workspaceId: string,
    profileHash: string,
  ) => {
    return db.transaction().execute((trx) =>
      repo.updateWorkspaceProfile(trx, workspaceId, {
        enabled: true,
        profileId: randomUUID(),
        profileHash,
      }),
    );
  };

  // Production publishes only generations created by stage(); the FK on
  // published_generation_id requires the same order in tests.
  const stageGeneration = async (
    db: Kysely<DbInterface>,
    key: { workspaceId: string; pageId: string },
    profileHash: string,
    inputRevision: string,
  ) => {
    const generationId = randomUUID();
    await db
      .insertInto('ragGenerations')
      .values({
        id: generationId,
        workspaceId: key.workspaceId,
        pageId: key.pageId,
        inputRevision,
        profileHash,
        status: 'staged',
      })
      .execute();
    return generationId;
  };

  it('rejects a publication CAS from an older revision', async () => {
    await setup(async (db, repo, key) => {
      await advance(db, repo, key, 'upsert', 'page');
      await advance(db, repo, key, 'upsert', 'page');
      await enableProfile(db, repo, key.workspaceId, 'profile-a');

      const stale = await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            toInputRevision(1),
            'profile-a',
            randomUUID(),
          ),
        );
      expect(stale).toBe('superseded');

      const state = await repo.find(db, key);
      expect(state?.publishedGenerationId).toBeNull();
    });
  });

  it('publishes the pointer only for the current live revision and profile', async () => {
    await setup(async (db, repo, key) => {
      const { inputRevision } = await advance(db, repo, key, 'upsert', 'page');
      const generationId = await stageGeneration(
        db,
        key,
        'profile-a',
        inputRevision,
      );

      await enableProfile(db, repo, key.workspaceId, 'profile-a');
      const outcome = await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            generationId,
          ),
        );
      expect(outcome).toBe('published');

      const state = await repo.find(db, key);
      expect(state?.publishedGenerationId).toBe(generationId);
      expect(state?.publishedInputRevision).toBe('1');

      await enableProfile(db, repo, key.workspaceId, 'profile-b');
      const mismatched = await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            randomUUID(),
          ),
        );
      expect(mismatched).toBe('superseded');
    });
  });

  it('reports disabled when the workspace profile is disabled', async () => {
    await setup(async (db, repo, key) => {
      const { inputRevision } = await advance(db, repo, key, 'upsert', 'page');

      const disabled = await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            randomUUID(),
          ),
        );
      expect(disabled).toBe('disabled');

      await enableProfile(db, repo, key.workspaceId, 'profile-a');
      await db.transaction().execute((trx) =>
        repo.updateWorkspaceProfile(trx, key.workspaceId, {
          enabled: false,
          profileId: randomUUID(),
          profileHash: 'profile-a',
        }),
      );
      const turnedOff = await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            randomUUID(),
          ),
        );
      expect(turnedOff).toBe('disabled');
    });
  });

  it('reports deleted for publication after the tombstone', async () => {
    await setup(async (db, repo, key) => {
      const { inputRevision } = await advance(db, repo, key, 'upsert', 'page');
      await enableProfile(db, repo, key.workspaceId, 'profile-a');
      await db.transaction().execute((trx) => repo.markHardDeleted(trx, key));

      const outcome = await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            randomUUID(),
          ),
        );
      expect(outcome).toBe('deleted');
    });
  });

  it('marks hard deletion once and clears the published pointer', async () => {
    await setup(async (db, repo, key) => {
      const { inputRevision } = await advance(db, repo, key, 'upsert', 'page');
      const generationId = await stageGeneration(
        db,
        key,
        'profile-a',
        inputRevision,
      );
      await enableProfile(db, repo, key.workspaceId, 'profile-a');
      await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            generationId,
          ),
        );

      const first = await db
        .transaction()
        .execute((trx) => repo.markHardDeleted(trx, key));
      const second = await db
        .transaction()
        .execute((trx) => repo.markHardDeleted(trx, key));
      expect(first).toBe(true);
      expect(second).toBe(false);

      const state = await repo.find(db, key);
      expect(state?.sourceStatus).toBe('hard_deleted');
      expect(state?.publishedGenerationId).toBeNull();
      expect(state?.publishedInputRevision).toBeNull();
      expect(state?.desiredInputRevision).toBe('1');
    });
  });

  it('keeps the tombstone and outbox when the pages row is hard deleted', async () => {
    await setup(async (db, repo, key) => {
      const { inputRevision } = await advance(db, repo, key, 'upsert', 'page');
      const generationId = await stageGeneration(
        db,
        key,
        'profile-a',
        inputRevision,
      );
      await db
        .insertInto('ragChunks')
        .values({
          id: randomUUID(),
          generationId,
          workspaceId: key.workspaceId,
          pageId: key.pageId,
          ordinal: 0,
          text: 'chunk',
          tokenCount: 2,
          textHash: 'hash',
          locator: { page: 1 },
        })
        .execute();
      await enableProfile(db, repo, key.workspaceId, 'profile-a');
      await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            generationId,
          ),
        );
      await db
        .insertInto('ragOutbox')
        .values({
          id: randomUUID(),
          workspaceId: key.workspaceId,
          pageId: key.pageId,
          inputRevision,
          operation: 'upsert',
          cause: 'page',
          occurredAt: new Date(),
        })
        .execute();

      // Production deletion path: tombstone the RAG state in the same
      // transaction that removes the page row itself.
      await db.transaction().execute(async (trx) => {
        await repo.markHardDeleted(trx, key);
        await trx.deleteFrom('pages').where('id', '=', key.pageId).execute();
      });

      const state = await repo.find(db, key);
      expect(state?.sourceStatus).toBe('hard_deleted');
      expect(state?.publishedGenerationId).toBeNull();
      expect(state?.publishedInputRevision).toBeNull();
      expect(await countRows(db, 'ragSourceState')).toBe(1);
      expect(await countRows(db, 'ragOutbox')).toBe(1);
      const generations = await db
        .selectFrom('ragGenerations')
        .where('pageId', '=', key.pageId)
        .execute();
      expect(generations).toHaveLength(0);
      const chunks = await db
        .selectFrom('ragChunks')
        .where('pageId', '=', key.pageId)
        .execute();
      expect(chunks).toHaveLength(0);

      // A late worker must not resurrect or republish the deleted identity.
      const late = await db
        .transaction()
        .execute((trx) =>
          repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            randomUUID(),
          ),
        );
      expect(late).toBe('deleted');
    });
  });
});
