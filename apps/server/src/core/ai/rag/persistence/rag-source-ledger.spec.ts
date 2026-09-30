import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import {
  DocumentKey,
  RagError,
  parseIndexRequest,
  serializeIndexRequest,
} from '../contracts';
import { RagOutboxRepository } from './rag-outbox.repository';
import { RagSourceLedger } from './rag-source-ledger';
import { RagStateRepository } from './rag-state.repository';
import {
  ragTestDbConfigured,
  seedWorkspace,
  withRagTestDb,
} from './rag-test-db';

(ragTestDbConfigured ? describe : describe.skip)('RagSourceLedger', () => {
  const record = (
    db: Kysely<DbInterface>,
    ledger: RagSourceLedger,
    key: DocumentKey,
    operation: 'upsert' | 'delete',
    cause: 'page' | 'restore',
  ) => {
    return db
      .transaction()
      .execute((trx) => ledger.recordChange(trx, key, operation, cause));
  };

  it('records a change and enqueues the exact IndexRequest in one transaction', async () => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const key = { workspaceId, pageId: randomUUID() };
      const stateRepository = new RagStateRepository(db);
      const outboxRepository = new RagOutboxRepository(db);
      const ledger = new RagSourceLedger(stateRepository, outboxRepository);

      const request = await record(db, ledger, key, 'upsert', 'page');

      expect(request.schemaVersion).toBe(1);
      expect(request.key).toEqual(key);
      expect(request.inputRevision).toBe('1');
      expect(request.operation).toBe('upsert');
      expect(request.cause).toBe('page');

      const state = await stateRepository.find(db, key);
      expect(state?.desiredInputRevision).toBe('1');
      expect(state?.sourceStatus).toBe('live');

      const pending = await outboxRepository.pending(db, 10);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual(request);
      expect(parseIndexRequest(serializeIndexRequest(request))).toEqual(
        request,
      );
    });
  });

  it('rolls the revision advance and outbox record back together', async () => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const key = { workspaceId, pageId: randomUUID() };
      const stateRepository = new RagStateRepository(db);
      const outboxRepository = new RagOutboxRepository(db);
      const ledger = new RagSourceLedger(stateRepository, outboxRepository);

      await expect(
        db.transaction().execute(async (trx) => {
          await ledger.recordChange(trx, key, 'upsert', 'page');
          throw new Error('source save failed');
        }),
      ).rejects.toThrow('source save failed');

      expect(await stateRepository.find(db, key)).toBeNull();
      expect(await outboxRepository.pending(db, 10)).toHaveLength(0);
    });
  });

  it('keeps revisions monotonic under concurrent transactions', async () => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const key = { workspaceId, pageId: randomUUID() };
      const stateRepository = new RagStateRepository(db);
      const outboxRepository = new RagOutboxRepository(db);
      const ledger = new RagSourceLedger(stateRepository, outboxRepository);

      const [first, second] = await Promise.all([
        record(db, ledger, key, 'upsert', 'page'),
        record(db, ledger, key, 'upsert', 'page'),
      ]);

      const revisions = [first.inputRevision, second.inputRevision].sort();
      expect(revisions).toEqual(['1', '2']);

      const state = await stateRepository.find(db, key);
      expect(state?.desiredInputRevision).toBe('2');
    });
  });

  it('advances one revision per change across delete and restore', async () => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const key = { workspaceId, pageId: randomUUID() };
      const stateRepository = new RagStateRepository(db);
      const outboxRepository = new RagOutboxRepository(db);
      const ledger = new RagSourceLedger(stateRepository, outboxRepository);

      await record(db, ledger, key, 'upsert', 'page');
      const deleted = await record(db, ledger, key, 'delete', 'page');
      expect(deleted.inputRevision).toBe('2');
      const afterDelete = await stateRepository.find(db, key);
      expect(afterDelete?.sourceStatus).toBe('deleted');

      const restored = await record(db, ledger, key, 'upsert', 'restore');
      expect(restored.inputRevision).toBe('3');
      const afterRestore = await stateRepository.find(db, key);
      expect(afterRestore?.sourceStatus).toBe('live');
    });
  });

  it('refuses to recreate a hard-deleted identity', async () => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const key = { workspaceId, pageId: randomUUID() };
      const stateRepository = new RagStateRepository(db);
      const outboxRepository = new RagOutboxRepository(db);
      const ledger = new RagSourceLedger(stateRepository, outboxRepository);

      await record(db, ledger, key, 'upsert', 'page');
      await db
        .transaction()
        .execute((trx) => stateRepository.markHardDeleted(trx, key));

      await expect(
        record(db, ledger, key, 'upsert', 'page'),
      ).rejects.toMatchObject({ code: 'INDEX_WRITE_FAILED' });
      await expect(
        record(db, ledger, key, 'upsert', 'page'),
      ).rejects.toBeInstanceOf(RagError);

      const state = await stateRepository.find(db, key);
      expect(state?.sourceStatus).toBe('hard_deleted');
      expect(state?.desiredInputRevision).toBe('1');
    });
  });
});
