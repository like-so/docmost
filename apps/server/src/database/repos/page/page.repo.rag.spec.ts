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
  },
);
