import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import {
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from '../persistence/rag-test-db';
import { RagStateRepository } from '../persistence/rag-state.repository';
import {
  buildPermissionRepos,
  makeUser,
  seedPageRestriction,
  seedSpaceMember,
  seedUser,
} from './rag-test-support';
import { RagEvidenceGate } from './rag-evidence-gate';
import { IndexProfile, RagEvidence } from '../contracts';

const PROFILE_HASH = 'profile-a';

const RESOLVED_PROFILE: IndexProfile = {
  parserVersion: 'parser-1',
  chunkerVersion: 'chunker-1',
  maxChunkTokens: 512,
  overlapTokens: 64,
  sourcePolicy: {
    requiredMimeTypes: ['text/plain'],
    imageInterpretation: 'disabled',
  },
  embedding: {
    driver: 'openai-compatible',
    endpointIdentity: null,
    model: 'test-embedding-model',
    dimensions: 2,
    tokenizerId: null,
    maxInputTokens: 8192,
  },
  profileId: '0f0a3c1e-8b2d-4c6e-9a70-d1e2f3a4b5c6',
  profileHash: PROFILE_HASH,
};

interface TestContext {
  db: Kysely<DbInterface>;
  workspaceId: string;
  actorUserId: string;
  stateRepo: RagStateRepository;
  gate: RagEvidenceGate;
}

/**
 * Seeds a page via the foundation helper and optionally joins the actor.
 */
const createPage = async (
  ctx: TestContext,
  opts: { member?: boolean } = {},
): Promise<{ pageId: string; spaceId: string }> => {
  const pageId = randomUUID();
  await seedPage(ctx.db, ctx.workspaceId, pageId);
  const spaceId = (await ctx.db
    .selectFrom('pages')
    .select('spaceId')
    .where('id', '=', pageId)
    .executeTakeFirst())!.spaceId;
  if (opts.member) {
    await seedSpaceMember(ctx.db, spaceId, ctx.actorUserId, 'writer');
  }
  return { pageId, spaceId };
};

/**
 * Exercises the real foundation state machine (same flow as the retriever
 * spec): advance -> stage generation and chunks -> enable profile -> CAS
 * publish -> mark the generation published.
 */
const publishPage = async (
  ctx: TestContext,
  pageId: string,
  chunks: Array<{ text: string }>,
  profileHash = PROFILE_HASH,
): Promise<string> => {
  const key = { workspaceId: ctx.workspaceId, pageId };
  const { inputRevision } = await ctx.db
    .transaction()
    .execute((trx) =>
      ctx.stateRepo.advanceForChange(trx, key, 'upsert', 'page'),
    );
  const generationId = randomUUID();
  await ctx.db
    .insertInto('ragGenerations')
    .values({
      id: generationId,
      workspaceId: ctx.workspaceId,
      pageId,
      inputRevision,
      profileHash,
      status: 'staged',
    })
    .execute();
  const chunkIds: string[] = [];
  for (const [ordinal, chunk] of chunks.entries()) {
    const chunkId = randomUUID();
    chunkIds.push(chunkId);
    await ctx.db
      .insertInto('ragChunks')
      .values({
        id: chunkId,
        generationId,
        workspaceId: ctx.workspaceId,
        pageId,
        ordinal,
        text: chunk.text,
        tokenCount: 8,
        textHash: `hash-${ordinal}`,
        locator: {
          pageId,
          headingPath: [],
          start: 0,
          end: chunk.text.length,
          offsetUnit: 'utf16',
          textHash: `hash-${ordinal}`,
        },
        embedding: null,
        embeddingDimensions: null,
      })
      .execute();
  }
  await ctx.db.transaction().execute((trx) =>
    ctx.stateRepo.updateWorkspaceProfile(trx, ctx.workspaceId, {
      enabled: true,
      profileId: RESOLVED_PROFILE.profileId,
      profileHash,
    }),
  );
  const outcome = await ctx.db
    .transaction()
    .execute((trx) =>
      ctx.stateRepo.compareAndSwapPublication(
        trx,
        key,
        inputRevision,
        profileHash,
        generationId,
      ),
    );
  if (outcome !== 'published') {
    throw new Error(`expected publication, got ${outcome}`);
  }
  await ctx.db
    .updateTable('ragGenerations')
    .set({ status: 'published', publishedAt: new Date() })
    .where('id', '=', generationId)
    .execute();
  return generationId;
};

const evidenceFor = (
  workspaceId: string,
  pageId: string,
  chunkId: string,
  inputRevision: string,
  text: string,
): RagEvidence => ({
  chunkId,
  key: { workspaceId, pageId },
  inputRevision,
  text,
  locator: null as never,
  score: { kind: 'keyword', value: 1 },
});

// Per-test DB provisioning exceeds the default 5s timeout on cold starts.
jest.setTimeout(30000);

(ragTestDbConfigured ? describe : describe.skip)('RagEvidenceGate', () => {
  const setup = async (
    run: (ctx: TestContext) => Promise<void>,
  ): Promise<void> => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const stateRepo = new RagStateRepository(db);
      const { pagePermissionRepo, spaceMemberRepo } = buildPermissionRepos(db);
      const actorUserId = randomUUID();
      await seedUser(db, makeUser(workspaceId, actorUserId));
      const gate = new RagEvidenceGate(db, pagePermissionRepo, spaceMemberRepo);
      await run({ db, workspaceId, actorUserId, stateRepo, gate });
    });
  };

  const validate = async (ctx: TestContext, evidence: RagEvidence[]) =>
    ctx.gate.validate(
      { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
      evidence,
    );

  it('keeps currently authorized evidence with input order preserved', async () => {
    await setup(async (ctx) => {
      const first = await createPage(ctx, { member: true });
      const second = await createPage(ctx, { member: true });
      const firstGeneration = await publishPage(ctx, first.pageId, [
        { text: 'first text' },
      ]);
      const secondGeneration = await publishPage(ctx, second.pageId, [
        { text: 'second text' },
      ]);
      const firstChunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', firstGeneration)
          .executeTakeFirstOrThrow()
      ).id as string;
      const secondChunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', secondGeneration)
          .executeTakeFirstOrThrow()
      ).id as string;

      const evidence = [
        evidenceFor(ctx.workspaceId, second.pageId, secondChunkId, '1', 'second text'),
        evidenceFor(ctx.workspaceId, first.pageId, firstChunkId, '1', 'first text'),
      ];
      const result = await validate(ctx, evidence);
      expect(result.map((item) => item.text)).toEqual([
        'second text',
        'first text',
      ]);
    });
  });

  it('drops a chunk whose published generation was superseded by a newer revision', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      const generationId = await publishPage(ctx, pageId, [
        { text: 'old text' },
      ]);
      const chunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', generationId)
          .executeTakeFirstOrThrow()
      ).id as string;

      // A later source change republishes the page at revision 2; the old
      // chunk is no longer part of the published generation.
      await ctx.db
        .transaction()
        .execute((trx) =>
          ctx.stateRepo.advanceForChange(
            trx,
            { workspaceId: ctx.workspaceId, pageId },
            'upsert',
            'page',
          ),
        );

      const result = await validate(ctx, [
        evidenceFor(ctx.workspaceId, pageId, chunkId, '1', 'old text'),
      ]);
      expect(result).toHaveLength(0);
    });
  });

  it('drops tombstoned and soft-deleted pages', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      const generationId = await publishPage(ctx, pageId, [
        { text: 'gone text' },
      ]);
      const chunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', generationId)
          .executeTakeFirstOrThrow()
      ).id as string;

      await ctx.db
        .transaction()
        .execute((trx) =>
          ctx.stateRepo.advanceForChange(
            trx,
            { workspaceId: ctx.workspaceId, pageId },
            'delete',
            'page',
          ),
        );
      expect(
        await validate(ctx, [evidenceFor(ctx.workspaceId, pageId, chunkId, '1', 'gone text')]),
      ).toHaveLength(0);

      await ctx.db
        .updateTable('pages')
        .set({ deletedAt: new Date() })
        .where('id', '=', pageId)
        .execute();
      expect(
        await validate(ctx, [evidenceFor(ctx.workspaceId, pageId, chunkId, '1', 'gone text')]),
      ).toHaveLength(0);
    });
  });

  it('never returns chunks from a staged generation of the same source', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      await publishPage(ctx, pageId, [{ text: 'published text' }]);

      // A concurrently staged newer revision shares page, workspace and
      // profile hash with the published generation.
      const stagedGenerationId = randomUUID();
      await ctx.db
        .insertInto('ragGenerations')
        .values({
          id: stagedGenerationId,
          workspaceId: ctx.workspaceId,
          pageId,
          inputRevision: '9',
          profileHash: PROFILE_HASH,
          status: 'staged',
        })
        .execute();
      const stagedChunkId = randomUUID();
      await ctx.db
        .insertInto('ragChunks')
        .values({
          id: stagedChunkId,
          generationId: stagedGenerationId,
          workspaceId: ctx.workspaceId,
          pageId,
          ordinal: 0,
          text: 'staged secret text',
          tokenCount: 8,
          textHash: 'hash-staged',
          locator: {
            pageId,
            headingPath: [],
            start: 0,
            end: 17,
            offsetUnit: 'utf16',
            textHash: 'hash-staged',
          },
          embedding: null,
          embeddingDimensions: null,
        })
        .execute();

      const result = await validate(ctx, [
        evidenceFor(ctx.workspaceId, pageId, stagedChunkId, '9', 'staged secret text'),
      ]);
      expect(result).toHaveLength(0);
    });
  });

  it('drops chunks on a page the actor cannot view and keeps authorized neighbors', async () => {
    await setup(async (ctx) => {
      const restricted = await createPage(ctx, { member: true });
      const restrictedGeneration = await publishPage(ctx, restricted.pageId, [
        { text: 'restricted text' },
      ]);
      const restrictedChunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', restrictedGeneration)
          .executeTakeFirstOrThrow()
      ).id as string;
      await seedPageRestriction(ctx.db, {
        id: restricted.pageId,
        workspaceId: ctx.workspaceId,
        spaceId: restricted.spaceId,
      });

      const allowed = await createPage(ctx, { member: true });
      const allowedGeneration = await publishPage(ctx, allowed.pageId, [
        { text: 'allowed text' },
      ]);
      const allowedChunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', allowedGeneration)
          .executeTakeFirstOrThrow()
      ).id as string;

      const result = await validate(ctx, [
        evidenceFor(
          ctx.workspaceId,
          restricted.pageId,
          restrictedChunkId,
          '1',
          'restricted text',
        ),
        evidenceFor(ctx.workspaceId, allowed.pageId, allowedChunkId, '1', 'allowed text'),
      ]);
      expect(result.map((item) => item.text)).toEqual(['allowed text']);
    });
  });

  it('drops chunks when the workspace profile is disabled', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      const generationId = await publishPage(ctx, pageId, [
        { text: 'disabled text' },
      ]);
      const chunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', generationId)
          .executeTakeFirstOrThrow()
      ).id as string;
      await ctx.db
        .updateTable('ragWorkspaceProfile')
        .set({ enabled: false })
        .where('workspaceId', '=', ctx.workspaceId)
        .execute();

      expect(
        await validate(ctx, [
          evidenceFor(ctx.workspaceId, pageId, chunkId, '1', 'disabled text'),
        ]),
      ).toHaveLength(0);
    });
  });

  it('returns an empty list unchanged without touching the database', async () => {
    await setup(async (ctx) => {
      expect(await validate(ctx, [])).toEqual([]);
    });
  });

  it('drops evidence keyed to a foreign workspace before any SQL work', async () => {
    await setup(async (ctx) => {
      const foreignWorkspaceId = randomUUID();
      const { pageId } = await createPage(ctx, { member: true });
      const generationId = await publishPage(ctx, pageId, [
        { text: 'foreign text' },
      ]);
      const chunkId = (
        await ctx.db
          .selectFrom('ragChunks')
          .select('id')
          .where('generationId', '=', generationId)
          .executeTakeFirstOrThrow()
      ).id as string;

      expect(
        await validate(ctx, [
          evidenceFor(
            foreignWorkspaceId,
            pageId,
            chunkId,
            '1',
            'foreign text',
          ),
        ]),
      ).toHaveLength(0);
    });
  });
});
