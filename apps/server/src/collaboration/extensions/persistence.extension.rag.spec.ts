import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import type { onStoreDocumentPayload } from '@hocuspocus/server';
import { Queue } from 'bullmq';
import { Kysely } from 'kysely';
import type { JSONContent } from '@tiptap/core';
import { DbInterface } from '@docmost/db/types/db.interface';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollabHistoryService } from '../services/collab-history.service';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import { RagOutboxRepository } from '../../core/ai/rag/persistence/rag-outbox.repository';
import {
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from '../../core/ai/rag/persistence/rag-test-db';
import { RagSourceLedger } from '../../core/ai/rag/persistence/rag-source-ledger';
import { RagStateRepository } from '../../core/ai/rag/persistence/rag-state.repository';
import { getPageId, tiptapExtensions } from '../collaboration.util';
import { PersistenceExtension } from './persistence.extension';

(ragTestDbConfigured ? describe : describe.skip)(
  'PersistenceExtension RAG ledger integration',
  () => {
    const stubQueue = () =>
      ({ add: async () => undefined }) as unknown as Queue;

    const stubEmitter = { emit: () => undefined } as unknown as EventEmitter2;

    const buildExtension = (
      db: Kysely<DbInterface>,
      pageRepo: PageRepo,
      ledger: RagSourceLedger,
    ) =>
      new PersistenceExtension(
        pageRepo,
        db,
        stubQueue(),
        stubQueue(),
        stubQueue(),
        {
          addContributors: async () => undefined,
        } as unknown as CollabHistoryService,
        {
          syncPageTransclusions: async () => undefined,
          syncPageReferences: async () => undefined,
        } as unknown as TransclusionService,
        ledger,
      );

    const docWithText = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });

    const buildCollabDocument = (json: unknown): Y.Doc => {
      const doc = TiptapTransformer.toYdoc(
        json,
        'default',
        tiptapExtensions,
      ) as Y.Doc;
      (
        doc as unknown as { broadcastStateless: () => void }
      ).broadcastStateless = () => undefined;
      return doc;
    };

    const seedEditingPage = async (
      db: Kysely<DbInterface>,
      workspaceId: string,
      pageId: string,
      userId: string,
      content: JSONContent,
    ) => {
      await db
        .insertInto('users')
        .values({
          id: userId,
          workspaceId,
          email: `${userId}@rag-test.local`,
          name: 'rag-tester',
        })
        .execute();
      await seedPage(db, workspaceId, pageId);
      await db
        .updateTable('pages')
        .set({ content, creatorId: userId })
        .where('id', '=', pageId)
        .execute();
    };

    const storePayload = (
      pageId: string,
      document: Y.Doc,
      userId: string,
    ): onStoreDocumentPayload =>
      ({
        documentName: `page.${pageId}`,
        document,
        lastContext: { user: { id: userId, name: 'rag-tester' } },
      }) as unknown as onStoreDocumentPayload;

    it('commits the page content save and the RAG ledger record together', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        const pageId = randomUUID();
        const userId = randomUUID();
        const initial = docWithText('initial body');
        await seedWorkspace(db, workspaceId);
        await seedEditingPage(db, workspaceId, pageId, userId, initial);

        const stateRepository = new RagStateRepository(db);
        const outboxRepository = new RagOutboxRepository(db);
        const ledger = new RagSourceLedger(stateRepository, outboxRepository);
        const pageRepo = new PageRepo(db, {} as SpaceMemberRepo, stubEmitter);
        const extension = buildExtension(db, pageRepo, ledger);

        await extension.onStoreDocument(
          storePayload(
            pageId,
            buildCollabDocument(docWithText('edited body')),
            userId,
          ),
        );

        const saved = await db
          .selectFrom('pages')
          .select(['content', 'textContent'])
          .where('id', '=', pageId)
          .executeTakeFirst();
        expect(JSON.stringify(saved.content)).toContain('edited body');

        const state = await stateRepository.find(db, {
          workspaceId,
          pageId,
        });
        expect(state?.desiredInputRevision).toBe('1');
        expect(state?.sourceStatus).toBe('live');

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

    it('leaves no RAG event when the collaboration save rolls back', async () => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        const pageId = randomUUID();
        const userId = randomUUID();
        const initial = docWithText('initial body');
        await seedWorkspace(db, workspaceId);
        await seedEditingPage(db, workspaceId, pageId, userId, initial);

        const stateRepository = new RagStateRepository(db);
        const outboxRepository = new RagOutboxRepository(db);
        const ledger = new RagSourceLedger(stateRepository, outboxRepository);

        class FailingPageRepo extends PageRepo {
          async updatePage(): Promise<never> {
            throw new Error('simulated save failure');
          }
        }
        const pageRepo = new FailingPageRepo(
          db,
          {} as SpaceMemberRepo,
          stubEmitter,
        );
        const extension = buildExtension(db, pageRepo, ledger);

        await extension.onStoreDocument(
          storePayload(
            pageId,
            buildCollabDocument(docWithText('edited body')),
            userId,
          ),
        );

        const saved = await db
          .selectFrom('pages')
          .select('content')
          .where('id', '=', pageId)
          .executeTakeFirst();
        expect(saved.content).toEqual(initial);

        const state = await stateRepository.find(db, {
          workspaceId,
          pageId,
        });
        expect(state).toBeNull();
        expect(await outboxRepository.pending(db, 10)).toHaveLength(0);
      });
    });
  },
);
