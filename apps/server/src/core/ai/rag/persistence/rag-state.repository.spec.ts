import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { PublishOutcome, toInputRevision } from '../contracts';
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

  it('rejects a stale-profile publication when a profile change commits first', async () => {
    await setup(async (db, repo, key) => {
      const { inputRevision } = await advance(db, repo, key, 'upsert', 'page');
      await enableProfile(db, repo, key.workspaceId, 'profile-a');
      const generationId = await stageGeneration(
        db,
        key,
        'profile-a',
        inputRevision,
      );

      const order: string[] = [];
      let releaseX: () => void = () => undefined;
      const xHold = new Promise<void>((resolve) => (releaseX = resolve));
      let releaseZ: () => void = () => undefined;
      const zHold = new Promise<void>((resolve) => (releaseZ = resolve));
      const releaseAll = () => {
        releaseX();
        releaseZ();
      };

      const waitFor = async <T>(
        probe: () => Promise<T>,
        accept: (value: T) => boolean,
        what: string,
      ): Promise<T> => {
        const deadline = Date.now() + 15000;
        for (;;) {
          const value = await probe();
          if (accept(value)) return value;
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };

      // Backends of the current test database only.
      const sourceRowWaiters = async () => {
        const rows = await sql<{
          pid: number;
          blocking: number[];
          query: string;
        }>`
          select a.pid,
                 pg_blocking_pids(a.pid) as blocking,
                 left(a.query, 200) as query
          from pg_stat_activity a
          where a.datname = current_database()
            and a.wait_event_type = 'Lock'
            and a.query ilike '%rag_source_state%'
            and a.pid <> pg_backend_pid()
        `.execute(db);
        return rows.rows;
      };
      const pinnedRowPid = async () => {
        const rows = await sql<{ pid: number }>`
          select a.pid
          from pg_stat_activity a
          where a.datname = current_database()
            and a.state = 'idle in transaction'
            and a.query ilike '%rag_source_state%'
            and a.pid <> pg_backend_pid()
        `.execute(db);
        return rows.rows[0]?.pid ?? null;
      };

      // X pins the source row without touching CAS-checked columns.
      const xDone = db
        .transaction()
        .execute(async (trx) => {
          await trx
            .updateTable('ragSourceState')
            .set({ updatedAt: new Date() })
            .where('workspaceId', '=', key.workspaceId)
            .where('pageId', '=', key.pageId)
            .execute();
          order.push('x-locked');
          await xHold;
        })
        .then(() => order.push('x-committed'));

      // Z holds an uncommitted profile change.
      const zDone = db
        .transaction()
        .execute(async (trx) => {
          await repo.updateWorkspaceProfile(trx, key.workspaceId, {
            enabled: true,
            profileId: randomUUID(),
            profileHash: 'profile-b',
          });
          order.push('z-applied');
          await zHold;
        })
        .then(() => order.push('z-committed'));

      // Y publishes for the still-current revision and must block on X.
      let yDone: Promise<PublishOutcome> = Promise.resolve('superseded');
      try {
        await waitFor(
          async () => order.includes('x-locked'),
          (locked) => locked,
          'X to pin the source row',
        );
        await waitFor(
          async () => order.includes('z-applied'),
          (applied) => applied,
          'Z to hold the uncommitted profile change',
        );

        yDone = db.transaction().execute(async (trx) => {
          const outcome = await repo.compareAndSwapPublication(
            trx,
            key,
            inputRevision,
            'profile-a',
            generationId,
          );
          order.push(`y:${outcome}`);
          return outcome;
        });

        const waiter = await waitFor(
          async () =>
            (await sourceRowWaiters()).find(
              (row) => row.blocking.length > 0,
            ) ?? null,
          (row) => row !== null,
          'the publication to block on the pinned source row',
        );
        const xPid = await waitFor(
          pinnedRowPid,
          (pid) => pid !== null,
          'the pinning transaction backend',
        );
        expect(waiter.blocking).toContain(xPid);

        // The profile change commits first; the publication must then
        // observe the committed profile and reject the old hash.
        releaseZ();
        await zDone;
        releaseX();
        const outcome = await yDone;
        await xDone;

        expect(outcome).toBe('superseded');
        const state = await repo.find(db, key);
        expect(state?.publishedGenerationId).toBeNull();
        expect(state?.publishedInputRevision).toBeNull();
        const profile = await repo.findWorkspaceProfile(db, key.workspaceId);
        expect(profile?.enabled).toBe(true);
        expect(profile?.profileHash).toBe('profile-b');
      } finally {
        releaseAll();
        await Promise.allSettled([xDone, yDone, zDone]);
      }
    });
  }, 30000);
});
