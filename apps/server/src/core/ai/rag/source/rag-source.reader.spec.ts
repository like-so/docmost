import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Readable } from 'stream';
import { Kysely } from 'kysely';
import type { JSONContent } from '@tiptap/core';
import { DbInterface } from '@docmost/db/types/db.interface';
import { StorageDriver } from '../../../../integrations/storage/interfaces';
import { StorageService } from '../../../../integrations/storage/storage.service';
import {
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from '../persistence/rag-test-db';
import { RagOutboxRepository } from '../persistence/rag-outbox.repository';
import { RagSourceLedger } from '../persistence/rag-source-ledger';
import { RagStateRepository } from '../persistence/rag-state.repository';
import { DocumentKey } from '../contracts';
import { RagSourceReader } from './rag-source.reader';

(ragTestDbConfigured ? describe : describe.skip)('RagSourceReader', () => {
  const docWithText = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  interface TestContext {
    db: Kysely<DbInterface>;
    ledger: RagSourceLedger;
    stateRepository: RagStateRepository;
    key: DocumentKey;
    pageId: string;
    workspaceId: string;
    spaceId: string;
    userId: string;
    bytes: Map<string, Buffer>;
    onReadStream?: () => Promise<void>;
  }

  const seedDocument = async (
    ctx: Pick<TestContext, 'db' | 'workspaceId' | 'pageId' | 'userId'>,
    content: JSONContent,
  ) => {
    const spaceId = randomUUID();
    await ctx.db
      .insertInto('users')
      .values({
        id: ctx.userId,
        workspaceId: ctx.workspaceId,
        email: `${ctx.userId}@rag-test.local`,
        name: 'rag-tester',
      })
      .execute();
    await ctx.db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId: ctx.workspaceId,
        slug: randomUUID(),
        name: 'rag-test',
      })
      .execute();
    await ctx.db
      .insertInto('pages')
      .values({
        id: ctx.pageId,
        workspaceId: ctx.workspaceId,
        spaceId,
        slugId: randomUUID().slice(0, 10),
        title: 'reader spec page',
        content,
        textContent: 'reader spec body',
        creatorId: ctx.userId,
      })
      .execute();
    return spaceId;
  };

  const seedAttachment = async (
    ctx: TestContext,
    fileName: string,
    bytes: Buffer,
    createdAt?: Date,
  ) => {
    const attachmentId = randomUUID();
    const filePath = `workspaces/${ctx.workspaceId}/attachments/${attachmentId}/${fileName}`;
    ctx.bytes.set(filePath, bytes);
    await ctx.db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        workspaceId: ctx.workspaceId,
        pageId: ctx.pageId,
        spaceId: ctx.spaceId,
        creatorId: ctx.userId,
        fileName,
        filePath,
        fileExt: fileName.split('.').pop() ?? 'bin',
        fileSize: String(bytes.length),
        mimeType: 'text/plain',
        createdAt,
      })
      .execute();
    return attachmentId;
  };

  const buildReader = (ctx: TestContext): RagSourceReader => {
    const driver = {
      read: async (filePath: string) => ctx.bytes.get(filePath),
      readStream: async (filePath: string) => {
        if (ctx.onReadStream) {
          await ctx.onReadStream();
        }
        return Readable.from([ctx.bytes.get(filePath)]);
      },
      exists: async () => true,
    } as unknown as StorageDriver;
    return new RagSourceReader(
      ctx.stateRepository,
      ctx.db,
      new StorageService(driver),
    );
  };

  const setupContext = async (
    db: Kysely<DbInterface>,
  ): Promise<TestContext> => {
    const workspaceId = randomUUID();
    const pageId = randomUUID();
    const userId = randomUUID();
    const ctx: TestContext = {
      db,
      ledger: null,
      stateRepository: new RagStateRepository(db),
      key: { workspaceId, pageId },
      pageId,
      workspaceId,
      spaceId: null,
      userId,
      bytes: new Map(),
    };
    ctx.ledger = new RagSourceLedger(
      ctx.stateRepository,
      new RagOutboxRepository(db),
    );
    await seedWorkspace(db, workspaceId);
    ctx.spaceId = await seedDocument(ctx, docWithText('reader spec body'));
    return ctx;
  };

  const record = (
    ctx: TestContext,
    operation: 'upsert' | 'delete',
    cause: 'page' | 'attachment' | 'restore',
  ) =>
    ctx.db
      .transaction()
      .execute((trx) =>
        ctx.ledger.recordChange(trx, ctx.key, operation, cause),
      );

  it('returns the committed snapshot with byte-level attachment hashes', async () => {
    await withRagTestDb(async (db) => {
      const ctx = await setupContext(db);
      // Distinct createdAt values pin the reader's (createdAt, id) ordering
      // instead of relying on random attachment ids to sort lexicographically.
      const first = await seedAttachment(
        ctx,
        'a.txt',
        Buffer.from('alpha bytes'),
        new Date(Date.now() - 2000),
      );
      const second = await seedAttachment(
        ctx,
        'b.txt',
        Buffer.from('beta bytes'),
        new Date(Date.now() - 1000),
      );
      const request = await record(ctx, 'upsert', 'page');

      const outcome = await buildReader(ctx).loadSnapshot(
        ctx.key,
        request.inputRevision,
      );

      expect(outcome.kind).toBe('snapshot');
      if (outcome.kind !== 'snapshot') return;
      const snapshot = outcome.value;
      expect(snapshot.key).toEqual(ctx.key);
      expect(snapshot.inputRevision).toBe('1');
      expect(snapshot.title).toBe('reader spec page');
      expect(snapshot.spaceId).toBe(ctx.spaceId);
      expect(snapshot.bodyJson).toEqual(docWithText('reader spec body'));
      expect(snapshot.bodyText).toBe('reader spec body');
      expect(snapshot.attachments.map((a) => a.attachmentId)).toEqual([
        first,
        second,
      ]);
      expect(snapshot.attachments[0]).toMatchObject({
        attachmentId: first,
        fileName: 'a.txt',
        mimeType: 'text/plain',
        byteSize: 11,
        storageRef: expect.any(String),
      });
      expect(snapshot.attachments[0].sourceHash).toBe(
        createHash('sha256').update(Buffer.from('alpha bytes')).digest('hex'),
      );
      expect(snapshot.attachments[1].sourceHash).toBe(
        createHash('sha256').update(Buffer.from('beta bytes')).digest('hex'),
      );
    });
  });

  it('returns superseded when the desired revision moved on', async () => {
    await withRagTestDb(async (db) => {
      const ctx = await setupContext(db);
      await record(ctx, 'upsert', 'page');
      await record(ctx, 'upsert', 'page');

      const reader = buildReader(ctx);
      await expect(reader.loadSnapshot(ctx.key, '1')).resolves.toEqual({
        kind: 'superseded',
      });

      const outcome = await reader.loadSnapshot(ctx.key, '2');
      expect(outcome.kind).toBe('snapshot');
    });
  });

  it('returns superseded when no source state exists', async () => {
    await withRagTestDb(async (db) => {
      const ctx = await setupContext(db);

      await expect(
        buildReader(ctx).loadSnapshot(ctx.key, '1'),
      ).resolves.toEqual({ kind: 'superseded' });
    });
  });

  it('returns deleted for tombstoned or physically removed sources', async () => {
    await withRagTestDb(async (db) => {
      const ctx = await setupContext(db);
      const deleted = await record(ctx, 'delete', 'page');

      const reader = buildReader(ctx);
      await expect(
        reader.loadSnapshot(ctx.key, deleted.inputRevision),
      ).resolves.toEqual({ kind: 'deleted' });

      const request = await record(ctx, 'upsert', 'restore');
      await db.deleteFrom('pages').where('id', '=', ctx.pageId).execute();
      await expect(
        reader.loadSnapshot(ctx.key, request.inputRevision),
      ).resolves.toEqual({ kind: 'deleted' });
    });
  });

  it('returns superseded when a change commits while bytes are loading', async () => {
    await withRagTestDb(async (db) => {
      const ctx = await setupContext(db);
      await seedAttachment(ctx, 'a.txt', Buffer.from('alpha bytes'));
      const request = await record(ctx, 'upsert', 'page');
      ctx.onReadStream = async () => {
        ctx.onReadStream = null;
        await record(ctx, 'upsert', 'attachment');
      };

      const outcome = await buildReader(ctx).loadSnapshot(
        ctx.key,
        request.inputRevision,
      );

      expect(outcome.kind).toBe('superseded');
    });
  });
});
