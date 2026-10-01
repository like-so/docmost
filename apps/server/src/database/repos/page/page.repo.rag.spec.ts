import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RagOutboxRepository } from '../../../core/ai/rag/persistence/rag-outbox.repository';
import {
  countRows,
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from '../../../core/ai/rag/persistence/rag-test-db';
import { RagSourceLedger } from '../../../core/ai/rag/persistence/rag-source-ledger';
import { RagStateRepository } from '../../../core/ai/rag/persistence/rag-state.repository';

(ragTestDbConfigured ? describe : describe.skip)(
  'PageRepo RAG producer',
  () => {
    const stubEmitter = { emit: () => undefined } as unknown as EventEmitter2;

    const buildRepo = (db: Kysely<DbInterface>) => {
      const stateRepository = new RagStateRepository(db);
      const ledger = new RagSourceLedger(
        stateRepository,
        new RagOutboxRepository(db),
      );
      return {
        stateRepository,
        pageRepo: new PageRepo(db, {} as SpaceMemberRepo, stubEmitter, ledger),
      };
    };

    const seedUserPage = async (
      db: Kysely<DbInterface>,
      workspaceId: string,
      pageId: string,
      slugId: string,
    ) => {
      await db
        .insertInto('users')
        .values({
          id: randomUUID(),
          workspaceId,
          email: `${pageId}@rag-test.local`,
          name: 'rag-tester',
        })
        .execute();
      await seedPage(db, workspaceId, pageId);
      await db
        .updateTable('pages')
        .set({ slugId })
        .where('id', '=', pageId)
        .execute();
    };

    it('commits the source change and outbox record with the page update', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        const pageId = randomUUID();
        await seedWorkspace(db, workspaceId);
        await seedUserPage(db, workspaceId, pageId, 'abcd1234ef');
        const { stateRepository, pageRepo } = buildRepo(db);

        await pageRepo.updatePages({ title: 'renamed' }, [pageId]);

        const saved = await db
          .selectFrom('pages')
          .select('title')
          .where('id', '=', pageId)
          .executeTakeFirst();
        expect(saved.title).toBe('renamed');

        const state = await stateRepository.find(db, { workspaceId, pageId });
        expect(state?.desiredInputRevision).toBe('1');
        expect(state?.sourceStatus).toBe('live');

        const outboxRepository = new RagOutboxRepository(db);
        const pending = await outboxRepository.pending(db, 10);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          key: { workspaceId, pageId },
          inputRevision: '1',
          operation: 'upsert',
          cause: 'page',
        });
      });
    });

    it('resolves slug inputs to actual document keys', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        const pageId = randomUUID();
        await seedWorkspace(db, workspaceId);
        await seedUserPage(db, workspaceId, pageId, 'zzzz9999yy');
        const { stateRepository, pageRepo } = buildRepo(db);

        await pageRepo.updatePages({ title: 'renamed' }, ['zzzz9999yy']);

        const state = await stateRepository.find(db, { workspaceId, pageId });
        expect(state?.desiredInputRevision).toBe('1');

        const outboxRepository = new RagOutboxRepository(db);
        const pending = await outboxRepository.pending(db, 10);
        expect(pending).toHaveLength(1);
        expect(pending[0].key).toEqual({ workspaceId, pageId });
      });
    });

    it('leaves no source change when the surrounding transaction rolls back', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        const pageId = randomUUID();
        await seedWorkspace(db, workspaceId);
        await seedUserPage(db, workspaceId, pageId, 'abcd1234ef');
        const { stateRepository, pageRepo } = buildRepo(db);

        await expect(
          db.transaction().execute(async (trx) => {
            await pageRepo.updatePages({ title: 'rolled back' }, [pageId], trx);
            throw new Error('forced rollback');
          }),
        ).rejects.toThrow('forced rollback');

        const saved = await db
          .selectFrom('pages')
          .select('title')
          .where('id', '=', pageId)
          .executeTakeFirst();
        expect(saved.title).not.toBe('rolled back');
        expect(await countRows(db, 'ragSourceState')).toBe(0);
        expect(await countRows(db, 'ragOutbox')).toBe(0);
      });
    });

    it('records nothing for page ids that match no rows', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        const pageId = randomUUID();
        await seedWorkspace(db, workspaceId);
        await seedUserPage(db, workspaceId, pageId, 'abcd1234ef');
        const { pageRepo } = buildRepo(db);

        await pageRepo.updatePages({ title: 'renamed' }, [randomUUID()]);

        expect(await countRows(db, 'ragSourceState')).toBe(0);
        expect(await countRows(db, 'ragOutbox')).toBe(0);
      });
    });

    const seedUser = async (db: Kysely<DbInterface>, workspaceId: string) => {
      const userId = randomUUID();
      await db
        .insertInto('users')
        .values({
          id: userId,
          workspaceId,
          email: `${userId}@rag-test.local`,
          name: 'rag-tester',
        })
        .execute();
      return userId;
    };

    const seedPageTree = async (
      db: Kysely<DbInterface>,
      workspaceId: string,
    ) => {
      const parentId = randomUUID();
      const childId = randomUUID();
      await seedPage(db, workspaceId, parentId);
      await seedPage(db, workspaceId, childId);
      await db
        .updateTable('pages')
        .set({ parentPageId: parentId })
        .where('id', '=', childId)
        .execute();
      return { parentId, childId };
    };

    const pageDeletedFlags = async (
      db: Kysely<DbInterface>,
      pageIds: string[],
    ) => {
      const rows = await db
        .selectFrom('pages')
        .select(['id', 'deletedAt'])
        .where('id', 'in', pageIds)
        .execute();
      return new Map(rows.map((row) => [row.id, row.deletedAt !== null]));
    };

    it('records a delete for every soft-deleted subtree id atomically', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        await seedWorkspace(db, workspaceId);
        const userId = await seedUser(db, workspaceId);
        const { parentId, childId } = await seedPageTree(db, workspaceId);
        const { stateRepository, pageRepo } = buildRepo(db);

        await pageRepo.removePage(parentId, userId, workspaceId);

        const deleted = await pageDeletedFlags(db, [parentId, childId]);
        expect(deleted.get(parentId)).toBe(true);
        expect(deleted.get(childId)).toBe(true);

        for (const pageId of [parentId, childId]) {
          const state = await stateRepository.find(db, {
            workspaceId,
            pageId,
          });
          expect(state?.desiredInputRevision).toBe('1');
          expect(state?.lastOperation).toBe('delete');
          expect(state?.sourceStatus).toBe('deleted');
        }

        const outboxRepository = new RagOutboxRepository(db);
        const pending = await outboxRepository.pending(db, 10);
        expect(pending).toHaveLength(2);
        expect(new Set(pending.map((r) => r.key.pageId))).toEqual(
          new Set([parentId, childId]),
        );
        expect(pending.every((r) => r.operation === 'delete')).toBe(true);
      });
    });

    it('leaves nothing when subtree delete recording fails', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        await seedWorkspace(db, workspaceId);
        const userId = await seedUser(db, workspaceId);
        const { parentId, childId } = await seedPageTree(db, workspaceId);
        const failingLedger = {
          recordChange: async () => {
            throw new Error('forced failure');
          },
        } as unknown as RagSourceLedger;
        const pageRepo = new PageRepo(
          db,
          {} as SpaceMemberRepo,
          stubEmitter,
          failingLedger,
        );

        await expect(
          pageRepo.removePage(parentId, userId, workspaceId),
        ).rejects.toThrow('forced failure');

        const deleted = await pageDeletedFlags(db, [parentId, childId]);
        expect(deleted.get(parentId)).toBe(false);
        expect(deleted.get(childId)).toBe(false);
        expect(await countRows(db, 'ragSourceState')).toBe(0);
        expect(await countRows(db, 'ragOutbox')).toBe(0);
      });
    });

    it('records restore and re-advances the desired revision', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        await seedWorkspace(db, workspaceId);
        const userId = await seedUser(db, workspaceId);
        const { parentId, childId } = await seedPageTree(db, workspaceId);
        const { stateRepository, pageRepo } = buildRepo(db);

        await pageRepo.removePage(parentId, userId, workspaceId);
        await pageRepo.restorePage(parentId, workspaceId);

        const deleted = await pageDeletedFlags(db, [parentId, childId]);
        expect(deleted.get(parentId)).toBe(false);
        expect(deleted.get(childId)).toBe(false);

        for (const pageId of [parentId, childId]) {
          const state = await stateRepository.find(db, {
            workspaceId,
            pageId,
          });
          expect(state?.desiredInputRevision).toBe('2');
          expect(state?.lastCause).toBe('restore');
          expect(state?.sourceStatus).toBe('live');
        }

        const outboxRepository = new RagOutboxRepository(db);
        const pending = await outboxRepository.pending(db, 10);
        expect(pending).toHaveLength(4);
        const restored = pending.filter((r) => r.cause === 'restore');
        expect(restored).toHaveLength(2);
        expect(new Set(restored.map((r) => r.key.pageId))).toEqual(
          new Set([parentId, childId]),
        );
        expect(restored.every((r) => r.operation === 'upsert')).toBe(true);
      });
    });
  },
);
