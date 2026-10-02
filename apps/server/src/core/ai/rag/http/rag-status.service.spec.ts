import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { PageAccessService } from '../../../page/page-access/page-access.service';
import SpaceAbilityFactory from '../../../casl/abilities/space-ability.factory';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import {
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from '../persistence/rag-test-db';
import { RagStateRepository } from '../persistence/rag-state.repository';
import { RagStatusService } from './rag-status.service';
import {
  buildPermissionRepos,
  makeUser,
  seedPagePermission,
  seedPageRestriction,
  seedSpaceMember,
  seedUser,
} from '../retrieval/rag-test-support';

const PROFILE_HASH = 'profile-a';

// Per-test DB provisioning exceeds the default 5s timeout on cold starts.
jest.setTimeout(30000);

(ragTestDbConfigured ? describe : describe.skip)('RagStatusService', () => {
  interface Ctx {
    db: Kysely<DbInterface>;
    workspaceId: string;
    user: ReturnType<typeof makeUser>;
    stateRepo: RagStateRepository;
    service: RagStatusService;
    createMemberPage: () => Promise<{ pageId: string; spaceId: string }>;
    publishPage: (
      pageId: string,
      opts?: { status?: 'published' | 'failed'; errorCode?: string },
    ) => Promise<string>;
  }

  const setup = async (run: (ctx: Ctx) => Promise<void>): Promise<void> => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const user = makeUser(workspaceId);
      await seedUser(db, user);

      const stateRepo = new RagStateRepository(db);
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
      const service = new RagStatusService(db, stateRepo, pageAccessService);

      const createMemberPage = async () => {
        const pageId = randomUUID();
        await seedPage(db, workspaceId, pageId);
        const spaceId = (await db
          .selectFrom('pages')
          .select('spaceId')
          .where('id', '=', pageId)
          .executeTakeFirst())!.spaceId;
        await seedSpaceMember(db, spaceId, user.id, 'writer');
        return { pageId, spaceId };
      };

      const publishPage = async (
        pageId: string,
        opts: { status?: 'published' | 'failed'; errorCode?: string } = {},
      ) => {
        const key = { workspaceId, pageId };
        const { inputRevision } = await db
          .transaction()
          .execute((trx) =>
            stateRepo.advanceForChange(trx, key, 'upsert', 'page'),
          );
        const generationId = randomUUID();
        await db
          .insertInto('ragGenerations')
          .values({
            id: generationId,
            workspaceId,
            pageId,
            inputRevision,
            profileHash: PROFILE_HASH,
            status: opts.status === 'failed' ? 'failed' : 'staged',
            errorCode: opts.errorCode ?? null,
          })
          .execute();
        await db.transaction().execute((trx) =>
          stateRepo.updateWorkspaceProfile(trx, workspaceId, {
            enabled: true,
            profileId: '0f0a3c1e-8b2d-4c6e-9a70-d1e2f3a4b5c6',
            profileHash: PROFILE_HASH,
          }),
        );
        if (opts.status === 'failed') {
          return generationId;
        }
        const outcome = await db
          .transaction()
          .execute((trx) =>
            stateRepo.compareAndSwapPublication(
              trx,
              key,
              inputRevision,
              PROFILE_HASH,
              generationId,
            ),
          );
        if (outcome !== 'published') {
          throw new Error(`expected publication, got ${outcome}`);
        }
        await db
          .updateTable('ragGenerations')
          .set({ status: 'published', publishedAt: new Date() })
          .where('id', '=', generationId)
          .execute();
        return generationId;
      };

      await run({
        db,
        workspaceId,
        user,
        stateRepo,
        service,
        createMemberPage,
        publishPage,
      });
    });
  };

  const enableProfile = async (
    db: Kysely<DbInterface>,
    workspaceId: string,
  ): Promise<void> => {
    await db.transaction().execute((trx) =>
      new RagStateRepository(db).updateWorkspaceProfile(trx, workspaceId, {
        enabled: true,
        profileId: '0f0a3c1e-8b2d-4c6e-9a70-d1e2f3a4b5c6',
        profileHash: PROFILE_HASH,
      }),
    );
  };

  it('reports disabled before the profile is enabled, and pending without state', async () => {
    await setup(
      async ({ db, workspaceId, user, service, createMemberPage }) => {
        const { pageId } = await createMemberPage();
        let status = await service.getStatus(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(status.phase).toBe('disabled');
        expect(status.desiredInputRevision).toBe('0');

        await enableProfile(db, workspaceId);
        status = await service.getStatus(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(status.phase).toBe('pending');
        expect(status.publishedInputRevision).toBeNull();
      },
    );
  });

  it('reports ready after a real publication, with pointer and generation', async () => {
    await setup(
      async ({ workspaceId, user, service, createMemberPage, publishPage }) => {
        const { pageId } = await createMemberPage();
        const generationId = await publishPage(pageId);
        const status = await service.getStatus(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(status.phase).toBe('ready');
        expect(status.generationId).toBe(generationId);
        expect(status.desiredInputRevision).toBe('1');
        expect(status.publishedInputRevision).toBe('1');
      },
    );
  });

  it('reports pending again after a newer revision is desired', async () => {
    await setup(
      async ({
        db,
        workspaceId,
        user,
        service,
        stateRepo,
        createMemberPage,
        publishPage,
      }) => {
        const { pageId } = await createMemberPage();
        await publishPage(pageId);
        await db
          .transaction()
          .execute((trx) =>
            stateRepo.advanceForChange(
              trx,
              { workspaceId, pageId },
              'upsert',
              'page',
            ),
          );
        const status = await service.getStatus(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(status.phase).toBe('pending');
        expect(status.desiredInputRevision).toBe('2');
        expect(status.publishedInputRevision).toBe('1');
      },
    );
  });

  it('reports failed with the generation error code', async () => {
    await setup(
      async ({ workspaceId, user, service, createMemberPage, publishPage }) => {
        const { pageId } = await createMemberPage();
        await publishPage(pageId, {
          status: 'failed',
          errorCode: 'EMBEDDING_UNAVAILABLE',
        });
        const status = await service.getStatus(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(status.phase).toBe('failed');
        expect(status.errorCode).toBe('EMBEDDING_UNAVAILABLE');
        expect(status.publishedInputRevision).toBeNull();
      },
    );
  });

  it('hides deleted and foreign pages and enforces view permission', async () => {
    await setup(
      async ({
        db,
        workspaceId,
        user,
        service,
        createMemberPage,
        publishPage,
      }) => {
        const { pageId } = await createMemberPage();
        await publishPage(pageId);

        await db
          .updateTable('pages')
          .set({ deletedAt: new Date() })
          .where('id', '=', pageId)
          .execute();
        await expect(
          service.getStatus(user, { id: workspaceId } as never, pageId),
        ).rejects.toBeInstanceOf(NotFoundException);

        await expect(
          service.getStatus(user, { id: workspaceId } as never, randomUUID()),
        ).rejects.toBeInstanceOf(NotFoundException);

        // A stranger is a user of the same workspace who is not a space member.
        // The foundation access adapter hides the page (NotFound) rather than
        // forbidding: SpaceAbilityFactory throws NotFound without a space role.
        const stranger = makeUser(workspaceId);
        await seedUser(db, stranger);
        const { pageId: memberPageId } = await createMemberPage();
        await publishPage(memberPageId);
        await expect(
          service.getStatus(
            stranger,
            { id: workspaceId } as never,
            memberPageId,
          ),
        ).rejects.toBeInstanceOf(NotFoundException);

        // A restricted page is viewable only with an explicit grant.
        const restricted = await createMemberPage();
        const pageAccessId = await seedPageRestriction(db, {
          id: restricted.pageId,
          workspaceId,
          spaceId: restricted.spaceId,
        });
        await publishPage(restricted.pageId);
        await expect(
          service.getStatus(
            user,
            { id: workspaceId } as never,
            restricted.pageId,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await seedPagePermission(db, pageAccessId, user.id, 'reader');
        const status = await service.getStatus(
          user,
          { id: workspaceId } as never,
          restricted.pageId,
        );
        expect(status.phase).toBe('ready');
      },
    );
  });

  it('reports deleted when the source is tombstoned', async () => {
    await setup(
      async ({
        db,
        workspaceId,
        user,
        service,
        stateRepo,
        createMemberPage,
        publishPage,
      }) => {
        const { pageId } = await createMemberPage();
        await publishPage(pageId);
        await db
          .transaction()
          .execute((trx) =>
            stateRepo.advanceForChange(
              trx,
              { workspaceId, pageId },
              'delete',
              'page',
            ),
          );
        const status = await service.getStatus(
          user,
          { id: workspaceId } as never,
          pageId,
        );
        expect(status.phase).toBe('deleted');
      },
    );
  });
});
