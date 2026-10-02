import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import {
  IndexRequest,
  RAG_SCHEMA_VERSION,
  toInputRevision,
} from '../contracts';
import { RagOutboxRepository } from './rag-outbox.repository';
import {
  ragTestDbConfigured,
  seedWorkspace,
  withRagTestDb,
} from './rag-test-db';

(ragTestDbConfigured ? describe : describe.skip)('RagOutboxRepository', () => {
  const setup = async (
    run: (
      db: Kysely<DbInterface>,
      repo: RagOutboxRepository,
      makeRequest: (overrides?: Partial<IndexRequest>) => IndexRequest,
    ) => Promise<void>,
  ) => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const makeRequest = (
        overrides: Partial<IndexRequest> = {},
      ): IndexRequest => ({
        schemaVersion: RAG_SCHEMA_VERSION,
        eventId: randomUUID(),
        key: { workspaceId, pageId: randomUUID() },
        inputRevision: toInputRevision(1),
        operation: 'upsert' as const,
        cause: 'page' as const,
        occurredAt: new Date().toISOString(),
        ...overrides,
      });
      await run(db, new RagOutboxRepository(db), makeRequest);
    });
  };

  it('round-trips the exact queue schema through storage', async () => {
    await setup(async (db, repo, makeRequest) => {
      const original = makeRequest();
      expect(await repo.insert(db, original)).toBe(true);

      const pending = await repo.pending(db, 10);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual(original);
    });
  });

  it('treats a duplicate event identity as a no-op', async () => {
    await setup(async (db, repo, makeRequest) => {
      const original = makeRequest();
      await repo.insert(db, original);
      expect(await repo.insert(db, original)).toBe(false);

      const pending = await repo.pending(db, 10);
      expect(pending).toHaveLength(1);
      expect(pending[0].eventId).toBe(original.eventId);
    });
  });

  it('orders pending records by creation order', async () => {
    await setup(async (db, repo, makeRequest) => {
      const first = makeRequest({ inputRevision: toInputRevision(1) });
      const second = makeRequest({ inputRevision: toInputRevision(2) });
      await repo.insert(db, second);
      await repo.insert(db, first);

      const pending = await repo.pending(db, 10);
      expect(pending.map((row) => row.eventId)).toEqual([
        second.eventId,
        first.eventId,
      ]);
    });
  });

  it('marks delivery conditionally and records redacted failure codes', async () => {
    await setup(async (db, repo, makeRequest) => {
      const original = makeRequest();
      await repo.insert(db, original);

      expect(await repo.markDelivered(db, original.eventId)).toBe(true);
      expect(await repo.markDelivered(db, original.eventId)).toBe(false);
      expect(await repo.pending(db, 10)).toHaveLength(0);

      const retried = makeRequest();
      await repo.insert(db, retried);
      await repo.markDeliveryFailed(
        db,
        retried.eventId,
        'EMBEDDING_UNAVAILABLE',
      );

      const rows = await (db as any)
        .selectFrom('ragOutbox')
        .selectAll()
        .execute();
      const failed = rows.find((row: any) => row.id === retried.eventId);
      expect(failed.attempts).toBe(1);
      expect(failed.lastErrorCode).toBe('EMBEDDING_UNAVAILABLE');
      expect(failed.status).toBe('pending');
    });
  });
});
