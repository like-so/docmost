import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { PageAccessService } from '../../../page/page-access/page-access.service';
import SpaceAbilityFactory from '../../../casl/abilities/space-ability.factory';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  countRows,
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from '../persistence/rag-test-db';
import { RagOutboxRepository } from '../persistence/rag-outbox.repository';
import { RagStateRepository } from '../persistence/rag-state.repository';
import { RagSourceLedger } from '../persistence/rag-source-ledger';
import { RagReindexService } from './rag-reindex.service';
import {
  buildPermissionRepos,
  makeUser,
  seedPagePermission,
  seedPageRestriction,
  seedSpaceMember,
  seedUser,
} from '../retrieval/rag-test-support';

// Per-test DB provisioning exceeds the default 5s timeout on cold starts.
jest.setTimeout(30000);

(ragTestDbConfigured ? describe : describe.skip)('RagReindexService', () => {
  interface Ctx {
    db: Kysely<DbInterface>;
    workspaceId: string;
    user: ReturnType<typeof makeUser>;
    service: RagReindexService;
    createMemberPage: (role?: 'reader' | 'writer') => Promise<{
      pageId: string;
      spaceId: string;
    }>;
  }

  const setup = async (run: (ctx: Ctx) => Promise<void>): Promise<void> => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const user = makeUser(workspaceId);
      await seedUser(db, user);

      const { pagePermissionRepo, spaceMemberRepo } = buildPermissionRepos(db);
      const spaceRepo = new SpaceRepo(db, new EventEmitter2());
      const pageAccessService = new PageAccessService(
        pagePermissionRepo,
        new SpaceAbilityFactory(
          spaceMemberRepo,
          spaceRepo,
          new WorkspaceRepo(db),
        ),
        spaceRepo,
      );
      const sourceLedger = new RagSourceLedger(
        new RagStateRepository(db),
        new RagOutboxRepository(db),
      );
      const service = new RagReindexService(
        db,
        sourceLedger,
        pageAccessService,
      );

      const createMemberPage = async (role: 'reader' | 'writer' = 'writer') => {
        const pageId = randomUUID();
        await seedPage(db, workspaceId, pageId);
        const spaceId = (await db
          .selectFrom('pages')
          .select('spaceId')
          .where('id', '=', pageId)
          .executeTakeFirst())!.spaceId;
        await seedSpaceMember(db, spaceId, user.id, role);
        return { pageId, spaceId };
      };

      await run({ db, workspaceId, user, service, createMemberPage });
    });
  };

  it('records a durable manual request through the real ledger', async () => {
    await setup(
      async ({ db, workspaceId, user, service, createMemberPage }) => {
        const { pageId } = await createMemberPage();

        const first = await service.reindex(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(first.phase).toBe('pending');
        expect(first.inputRevision).toBe('1');

        const second = await service.reindex(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(second.inputRevision).toBe('2');

        const outboxRows = await db
          .selectFrom('ragOutbox')
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .orderBy('createdAt', 'asc')
          .execute();
        expect(outboxRows).toHaveLength(2);
        for (const row of outboxRows) {
          expect(row.operation).toBe('upsert');
          expect(row.cause).toBe('manual');
          expect(row.status).toBe('pending');
        }

        const stateRow = await db
          .selectFrom('ragSourceState')
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .where('pageId', '=', pageId)
          .executeTakeFirst();
        expect(stateRow?.desiredInputRevision).toBe('2');
        expect(stateRow?.sourceStatus).toBe('live');
        expect(await countRows(db, 'ragOutbox')).toBe(2);
      },
    );
  });

  it('denies readers and users without view access', async () => {
    await setup(
      async ({ db, workspaceId, user, service, createMemberPage }) => {
        const readerPage = await createMemberPage('reader');
        await expect(
          service.reindex(
            user,
            { id: workspaceId } as never,
            readerPage.pageId,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        const { pageId } = await createMemberPage();
        const pageAccessId = await seedPageRestriction(db, {
          id: pageId,
          workspaceId,
          spaceId: (await db
            .selectFrom('pages')
            .select('spaceId')
            .where('id', '=', pageId)
            .executeTakeFirst())!.spaceId,
        });
        await expect(
          service.reindex(user, { id: workspaceId } as never, pageId),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await seedPagePermission(db, pageAccessId, user.id, 'reader');
        await expect(
          service.reindex(user, { id: workspaceId } as never, pageId),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await seedPagePermission(db, pageAccessId, user.id, 'writer');
        await expect(
          service.reindex(user, { id: workspaceId } as never, pageId),
        ).resolves.toMatchObject({ phase: 'pending' });
      },
    );
  });

  it('hides deleted and foreign pages', async () => {
    await setup(
      async ({ db, workspaceId, user, service, createMemberPage }) => {
        const { pageId } = await createMemberPage();
        await db
          .updateTable('pages')
          .set({ deletedAt: new Date() })
          .where('id', '=', pageId)
          .execute();
        await expect(
          service.reindex(user, { id: workspaceId } as never, pageId),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.reindex(user, { id: workspaceId } as never, randomUUID()),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await countRows(db, 'ragOutbox')).toBe(0);
      },
    );
  });
});
