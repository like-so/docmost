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
import { RagRetrieverService } from './rag-retriever.service';
import {
  FixtureEmbeddingPort,
  FixtureProfileResolver,
  buildPermissionRepos,
  makeUser,
  seedPagePermission,
  seedPageRestriction,
  seedSpaceMember,
  seedUser,
} from './rag-test-support';
import { IndexProfile, RagEvidence, RagRerankResult } from '../contracts';

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
  retriever: RagRetrieverService;
}

/**
 * Fixture rerank port: records the passages it received and derives the
 * model scores from a test-supplied function (a null simulates an
 * unavailable model, reported as not_configured per the port contract).
 */
class FixtureRerankPort {
  calls = 0;
  receivedQueries: string[] = [];
  receivedPassages: string[][] = [];
  receivedModels: string[] = [];
  constructor(
    private readonly scoreFor: (
      query: string,
      passages: string[],
    ) => number[] | null,
  ) {}

  async rerank(
    _workspaceId: string,
    model: string,
    query: string,
    passages: string[],
  ): Promise<RagRerankResult> {
    this.calls += 1;
    this.receivedModels.push(model);
    this.receivedQueries.push(query);
    this.receivedPassages.push(passages);
    const scores = this.scoreFor(query, passages);
    return scores ? { status: 'ok', scores } : { status: 'not_configured' };
  }
}

/** Seeds a page via the foundation helper and optionally joins the actor. */
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

// Per-test DB provisioning exceeds the default 5s timeout on cold starts.
jest.setTimeout(30000);

(ragTestDbConfigured ? describe : describe.skip)('RagRetrieverService', () => {
  const setup = async (
    run: (ctx: TestContext) => Promise<void>,
    queryVectors: Record<string, number[]> = {},
    rerankPort?: FixtureRerankPort,
  ): Promise<void> => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const stateRepo = new RagStateRepository(db);
      const { pagePermissionRepo, spaceMemberRepo } = buildPermissionRepos(db);
      const actorUserId = randomUUID();
      await seedUser(db, makeUser(workspaceId, actorUserId));
      const retriever = new RagRetrieverService(
        db,
        stateRepo,
        new FixtureProfileResolver(RESOLVED_PROFILE),
        new FixtureEmbeddingPort(queryVectors, PROFILE_HASH),
        pagePermissionRepo,
        spaceMemberRepo,
        rerankPort,
      );
      await run({ db, workspaceId, actorUserId, stateRepo, retriever });
    });
  };

  /** Overwrites the workspace settings JSON for retrieval-settings tests. */
  const setWorkspaceSettings = async (
    ctx: TestContext,
    settings: Record<string, unknown>,
  ): Promise<void> => {
    await ctx.db
      .updateTable('workspaces')
      .set({ settings: settings as never })
      .where('id', '=', ctx.workspaceId)
      .execute();
  };

  /**
   * Exercises the real foundation state machine: advance -> stage generation
   * and chunks -> enable profile -> CAS publish -> mark the generation
   * published. Chunk vectors are stored as JSON exactly like the indexer's
   * GenerationStore would.
   */
  const publishPage = async (
    ctx: TestContext,
    pageId: string,
    chunks: Array<{ text: string; embedding: number[] | null }>,
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
    for (const [ordinal, chunk] of chunks.entries()) {
      await ctx.db
        .insertInto('ragChunks')
        .values({
          id: randomUUID(),
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
          embedding: chunk.embedding
            ? (JSON.stringify(chunk.embedding) as never)
            : null,
          embeddingDimensions: chunk.embedding?.length ?? null,
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

  const retrieve = async (
    ctx: TestContext,
    mode: 'semantic' | 'keyword',
    overrides: {
      query?: string;
      spaceId?: string;
      pageIds?: string[];
      limit?: number;
    } = {},
  ): Promise<RagEvidence[]> => {
    const result = await ctx.retriever.retrieve(
      { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
      {
        query: overrides.query ?? 'search terms',
        mode,
        limit: overrides.limit ?? 10,
        ...(overrides.spaceId ? { spaceId: overrides.spaceId } : {}),
        ...(overrides.pageIds ? { pageIds: overrides.pageIds } : {}),
      },
    );
    return result.evidence;
  };

  it('ranks semantic evidence by real query embeddings, not by lexical hits', async () => {
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'unrelated vocabulary entirely', embedding: [1, 0] },
          { text: 'search terms live here', embedding: [0, 1] },
        ]);

        // The query shares no tokens with the top chunk: a lexical rerank
        // could not place it first, only the query embedding can.
        const evidence = await retrieve(ctx, 'semantic', {
          query: 'completely other tokens',
        });
        expect(evidence).toHaveLength(2);
        expect(evidence[0].text).toBe('unrelated vocabulary entirely');
        expect(evidence[0].score.kind).toBe('cosine');
        expect(evidence[0].score.value).toBeCloseTo(1, 6);
        expect(evidence[1].score.value).toBeCloseTo(0, 6);
        expect(evidence[0].inputRevision).toBe('1');
      },
      { 'completely other tokens': [1, 0] },
    );
  });

  it('drops semantic candidates without a usable vector of the right dimensions', async () => {
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'first chunk', embedding: null },
          { text: 'second chunk', embedding: [1, 0, 0] },
          { text: 'third chunk', embedding: [1, 0] },
        ]);

        const evidence = await retrieve(ctx, 'semantic', { query: 'probe' });
        expect(evidence).toHaveLength(1);
        expect(evidence[0].text).toBe('third chunk');
      },
      { probe: [1, 0] },
    );
  });

  it('returns BM25 keyword evidence for keyword mode without embedding the query', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      await publishPage(ctx, pageId, [
        { text: 'the quarterly report numbers', embedding: [0, 1] },
        { text: 'something else entirely', embedding: [1, 0] },
      ]);

      // No query vectors are configured: a semantic path would throw
      // EMBEDDING_NOT_CONFIGURED, so a passing keyword retrieval proves the
      // query embedding is never requested.
      const evidence = await retrieve(ctx, 'keyword', {
        query: 'quarterly report',
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0].text).toBe('the quarterly report numbers');
      expect(evidence[0].score.kind).toBe('keyword');
      expect(evidence[0].score.value).toBeGreaterThan(0);
    });
  });

  it('caps keyword recall by BM25 over the full matching set, not by ts_rank preselection', async () => {
    await setup(async (ctx) => {
      // ts_rank ranks the repeated common term far above the rare term, but
      // BM25 (matching the pinned reference paradedb.score ordering) must
      // keep the rare-term chunk when the recall window holds one candidate.
      const commonPage = await createPage(ctx, { member: true });
      await publishPage(ctx, commonPage.pageId, [
        {
          text: 'alpha alpha alpha alpha alpha alpha alpha alpha filler filler filler filler',
          embedding: null,
        },
      ]);
      const rarePage = await createPage(ctx, { member: true });
      await publishPage(ctx, rarePage.pageId, [
        { text: 'alpha zeta', embedding: null },
      ]);

      const evidence = await retrieve(ctx, 'keyword', {
        query: 'alpha zeta',
        limit: 1,
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0].text).toBe('alpha zeta');
      expect(evidence[0].score.kind).toBe('keyword');
      expect(evidence[0].score.value).toBeGreaterThan(0);
    });
  });

  it('excludes a page whose published revision no longer equals the desired revision', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      await publishPage(ctx, pageId, [
        { text: 'stale text', embedding: [1, 0] },
      ]);

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

      expect(await retrieve(ctx, 'semantic', { query: 'probe' })).toHaveLength(
        0,
      );
      expect(
        await retrieve(ctx, 'keyword', { query: 'stale text' }),
      ).toHaveLength(0);
    });
  });

  it('excludes tombstoned and soft-deleted sources', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      await publishPage(ctx, pageId, [
        { text: 'deleted text', embedding: [1, 0] },
      ]);

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
      expect(await retrieve(ctx, 'semantic', { query: 'probe' })).toHaveLength(
        0,
      );
      expect(
        await retrieve(ctx, 'keyword', { query: 'deleted text' }),
      ).toHaveLength(0);

      await ctx.db
        .updateTable('pages')
        .set({ deletedAt: new Date() })
        .where('id', '=', pageId)
        .execute();
      expect(
        await retrieve(ctx, 'keyword', { query: 'deleted text' }),
      ).toHaveLength(0);
    });
  });

  it('never returns chunks from a foreign workspace', async () => {
    await setup(async (ctx) => {
      const foreignWorkspaceId = randomUUID();
      await seedWorkspace(ctx.db, foreignWorkspaceId);
      const foreignCtx: TestContext = {
        ...ctx,
        workspaceId: foreignWorkspaceId,
        stateRepo: new RagStateRepository(ctx.db),
      };
      const foreignPage = await createPage(foreignCtx, { member: true });
      await publishPage(foreignCtx, foreignPage.pageId, [
        { text: 'foreign secret text', embedding: [1, 0] },
      ]);

      expect(await retrieve(ctx, 'semantic', { query: 'probe' })).toHaveLength(
        0,
      );
      expect(
        await retrieve(ctx, 'keyword', { query: 'foreign secret' }),
      ).toHaveLength(0);
    });
  });

  it('invalidates published generations when the workspace profile changes', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      await publishPage(ctx, pageId, [
        { text: 'old profile text', embedding: [1, 0] },
      ]);

      await ctx.db.transaction().execute((trx) =>
        ctx.stateRepo.updateWorkspaceProfile(trx, ctx.workspaceId, {
          enabled: true,
          profileId: '1f0a3c1e-8b2d-4c6e-9a70-d1e2f3a4b5c6',
          profileHash: 'profile-b',
        }),
      );

      expect(await retrieve(ctx, 'semantic', { query: 'probe' })).toHaveLength(
        0,
      );
      expect(
        await retrieve(ctx, 'keyword', { query: 'old profile' }),
      ).toHaveLength(0);
    });
  });

  it('requires space membership and rechecks page-level restrictions', async () => {
    await setup(
      async (ctx) => {
        const memberPage = await createPage(ctx, { member: true });
        await publishPage(ctx, memberPage.pageId, [
          { text: 'member text', embedding: [1, 0] },
        ]);

        const strangerPage = await createPage(ctx);
        await publishPage(ctx, strangerPage.pageId, [
          { text: 'stranger text', embedding: [1, 0] },
        ]);

        const restrictedPage = await createPage(ctx, { member: true });
        await publishPage(ctx, restrictedPage.pageId, [
          { text: 'restricted text', embedding: [1, 0] },
        ]);
        const pageAccessId = await seedPageRestriction(ctx.db, {
          id: restrictedPage.pageId,
          workspaceId: ctx.workspaceId,
          spaceId: restrictedPage.spaceId,
        });

        let evidence = await retrieve(ctx, 'semantic', { query: 'probe' });
        expect(evidence.map((item) => item.text)).toEqual(['member text']);

        // A reader grant on the restricted page restores its evidence.
        await seedPagePermission(
          ctx.db,
          pageAccessId,
          ctx.actorUserId,
          'reader',
        );
        evidence = await retrieve(ctx, 'semantic', { query: 'probe' });
        // Both chunks score an identical cosine of 1; the service makes no
        // tie-order promise, so compare the evidence set.
        expect(evidence.map((item) => item.text).sort()).toEqual([
          'member text',
          'restricted text',
        ]);
      },
      { probe: [1, 0] },
    );
  });

  it('honors spaceId and pageIds scope filters', async () => {
    await setup(
      async (ctx) => {
        const pageA = await createPage(ctx, { member: true });
        const pageB = await createPage(ctx, { member: true });
        await publishPage(ctx, pageA.pageId, [
          { text: 'text of A', embedding: [1, 0] },
        ]);
        await publishPage(ctx, pageB.pageId, [
          { text: 'text of B', embedding: [1, 0] },
        ]);

        const scoped = await retrieve(ctx, 'semantic', {
          query: 'probe',
          spaceId: pageB.spaceId,
        });
        expect(scoped.map((item) => item.key.pageId)).toEqual([pageB.pageId]);

        const byIds = await retrieve(ctx, 'semantic', {
          query: 'probe',
          pageIds: [pageA.pageId],
        });
        expect(byIds.map((item) => item.key.pageId)).toEqual([pageA.pageId]);

        // A pageIds scope naming a foreign page can only ever return nothing.
        expect(
          await retrieve(ctx, 'semantic', {
            query: 'probe',
            pageIds: [randomUUID()],
          }),
        ).toHaveLength(0);
      },
      { probe: [1, 0] },
    );
  });

  it('returns no evidence when the workspace profile is disabled', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      await publishPage(ctx, pageId, [{ text: 'text', embedding: [1, 0] }]);

      await ctx.db.transaction().execute((trx) =>
        ctx.stateRepo.updateWorkspaceProfile(trx, ctx.workspaceId, {
          enabled: false,
          profileId: RESOLVED_PROFILE.profileId,
          profileHash: PROFILE_HASH,
        }),
      );
      expect(await retrieve(ctx, 'semantic', { query: 'probe' })).toHaveLength(
        0,
      );
      expect(await retrieve(ctx, 'keyword', { query: 'text' })).toHaveLength(0);
    });
  });

  it('honors the limit and returns no evidence for a blank query', async () => {
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'alpha', embedding: [1, 0] },
          { text: 'beta', embedding: [0.7, 0.7] },
          { text: 'gamma', embedding: [0, 1] },
        ]);

        const evidence = await retrieve(ctx, 'semantic', {
          query: 'probe',
          limit: 2,
        });
        expect(evidence).toHaveLength(2);

        expect(
          await ctx.retriever.retrieve(
            { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
            { query: '   ', mode: 'semantic', limit: 5 },
          ),
        ).toEqual({
          evidence: [],
          retrieval: { mode: 'semantic', rerankStatus: 'not_applicable' },
        });
      },
      { probe: [0.9, 0.1], alpha: [1, 0], beta: [0.7, 0.7], gamma: [0, 1] },
    );
  });

  it('fuses dense and keyword routes with weighted RRF in hybrid mode', async () => {
    await setup(
      async (ctx) => {
        const densePage = await createPage(ctx, { member: true });
        const keywordPage = await createPage(ctx, { member: true });
        // 'alpha text' is reachable by both routes and wins the top rank on
        // each (best cosine; shortest BM25 document for the 'alpha' term).
        // 'alpha only' is reachable by the keyword route alone (a longer
        // document, so a strictly lower BM25 score); 'dense only' matches the
        // vector but shares no token with the query, dropping under the
        // vector threshold.
        await publishPage(ctx, densePage.pageId, [
          { text: 'alpha text', embedding: [1, 0] },
        ]);
        await publishPage(ctx, keywordPage.pageId, [
          {
            text: 'alpha only appears much later in a longer body',
            embedding: null,
          },
          { text: 'dense only', embedding: [0, 1] },
        ]);

        const result = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'hybrid', limit: 10 },
        );
        expect(result.evidence.map((item) => item.text)).toEqual([
          'alpha text',
          'alpha only appears much later in a longer body',
        ]);
        expect(result.evidence[0].score.kind).toBe('rrf');
        // Weighted RRF (k=60, weights 0.7/0.3) normalized by the total weight:
        // rank 1 on both routes reaches the maximum fused score of 1.
        expect(result.evidence[0].score.value).toBeCloseTo(1, 8);
        // Keyword rank 2 alone: 0.3/(60+2), normalized by (0.7+0.3)/(60+1).
        expect(result.evidence[1].score.value).toBeCloseTo(
          (0.3 / 62) * (61 / 1),
          8,
        );
        // No rerank model configured: the fused order is the final answer.
        expect(result.retrieval).toEqual({
          mode: 'hybrid',
          rerankStatus: 'not_configured',
        });
      },
      { alpha: [1, 0] },
    );
  });

  it('reranks the hybrid pool through the configured rerank model', async () => {
    const rerankPort = new FixtureRerankPort((_query, passages) =>
      passages.map((passage) => (passage.includes('delta') ? 0.9 : 0.05)),
    );
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'alpha beta gamma', embedding: null },
          { text: 'alpha delta', embedding: null },
        ]);
        await setWorkspaceSettings(ctx, {
          rag: {
            retrievalSettings: {
              rerankModel: 'rerank-model',
              rerankTopK: 2,
              rerankThreshold: 0.2,
            },
          },
        });

        const result = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'hybrid', limit: 10 },
        );
        expect(rerankPort.calls).toBe(1);
        expect(rerankPort.receivedQueries).toEqual(['alpha']);
        // The 0.05 model score falls below the 0.2 threshold: only the
        // reranked winner survives, with a composite rerank score.
        expect(result.evidence).toHaveLength(1);
        expect(result.evidence[0].text).toBe('alpha delta');
        expect(result.evidence[0].score.kind).toBe('rerank');
        // 0.6 * 0.9 + 0.3 * base + 0.1 with a base in (0, 1].
        expect(result.evidence[0].score.value).toBeGreaterThan(0.6);
        expect(result.retrieval).toEqual({
          mode: 'hybrid',
          rerankStatus: 'applied',
        });
      },
      {},
      rerankPort,
    );
  });

  it('keeps the fused order when the rerank model is unavailable', async () => {
    const rerankPort = new FixtureRerankPort(() => null);
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'alpha beta gamma', embedding: null },
          { text: 'alpha delta', embedding: null },
        ]);
        await setWorkspaceSettings(ctx, {
          rag: {
            retrievalSettings: {
              rerankModel: 'rerank-model',
              rerankTopK: 2,
            },
          },
        });

        const result = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'hybrid', limit: 10 },
        );
        expect(rerankPort.calls).toBe(1);
        expect(result.evidence.map((item) => item.score.kind)).toEqual([
          'keyword',
          'keyword',
        ]);
        // The model is configured but reports unavailable: the fused order
        // stands and the status records the not_configured port outcome.
        expect(result.retrieval).toEqual({
          mode: 'hybrid',
          rerankStatus: 'not_configured',
        });
      },
      {},
      rerankPort,
    );
  });

  it('keeps the fused order when the rerank stage throws', async () => {
    const rerankPort = new FixtureRerankPort(() => {
      throw new Error('rerank endpoint down');
    });
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'alpha beta gamma', embedding: null },
          { text: 'alpha delta', embedding: null },
        ]);
        await setWorkspaceSettings(ctx, {
          rag: {
            retrievalSettings: {
              rerankModel: 'rerank-model',
              rerankTopK: 2,
            },
          },
        });

        const result = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'hybrid', limit: 10 },
        );
        expect(result.evidence.map((item) => item.score.kind)).toEqual([
          'keyword',
          'keyword',
        ]);
        expect(result.retrieval).toEqual({
          mode: 'hybrid',
          rerankStatus: 'failed',
        });
      },
      {},
      rerankPort,
    );
  });

  it('honors indexingStrategy channel gates from stored settings', async () => {
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'alpha text', embedding: [1, 0] },
        ]);

        // Keyword-only: semantic retrieval has no vector channel to serve.
        await setWorkspaceSettings(ctx, {
          rag: {
            indexProfileConfig: {
              indexingStrategy: { vectorEnabled: false, keywordEnabled: true },
            },
          },
        });
        const semantic = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'semantic', limit: 10 },
        );
        expect(semantic.evidence).toHaveLength(0);
        const hybrid = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'hybrid', limit: 10 },
        );
        expect(hybrid.evidence.map((item) => item.text)).toEqual([
          'alpha text',
        ]);
        // Single-route fusion keeps the route's own score kind (reference
        // fuseOrDeduplicate only computes RRF when both routes contributed).
        expect(hybrid.evidence[0].score.kind).toBe('keyword');

        // Vector-only: the keyword route is gated off entirely.
        await setWorkspaceSettings(ctx, {
          rag: {
            indexProfileConfig: {
              indexingStrategy: { vectorEnabled: true, keywordEnabled: false },
            },
          },
        });
        const keyword = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'keyword', limit: 10 },
        );
        expect(keyword.evidence).toHaveLength(0);
      },
      { alpha: [1, 0] },
    );
  });

  it('never serves chunks from a staged generation of the same source', async () => {
    await setup(async (ctx) => {
      const { pageId } = await createPage(ctx, { member: true });
      const publishedGenerationId = await publishPage(ctx, pageId, [
        { text: 'published text', embedding: null },
      ]);

      // A concurrently staged newer revision: its chunks share page,
      // workspace and profile hash with the published generation and would
      // leak through a source-state-only join.
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
      await ctx.db
        .insertInto('ragChunks')
        .values({
          id: randomUUID(),
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

      const evidence = await retrieve(ctx, 'keyword', {
        query: 'staged secret published text',
      });
      expect(evidence.map((item) => item.text)).toEqual(['published text']);
      expect(evidence[0].inputRevision).toBe('1');
      expect(publishedGenerationId).toBeTruthy();
    });
  });

  it('fills the keyword recall budget with authorized candidates after restricted pages', async () => {
    await setup(async (ctx) => {
      // 60 short alpha-dense chunks on a page restricted against the actor:
      // any single BM25-ordered window of 50 rows contains only restricted
      // candidates, so an authorize-after-cap pipeline would return nothing.
      const restrictedPage = await createPage(ctx, { member: true });
      const chunks = Array.from({ length: 60 }, (_, index) => ({
        text: `alpha alpha filler ${index}`,
        embedding: null,
      }));
      await publishPage(ctx, restrictedPage.pageId, chunks);
      const pageAccessId = await seedPageRestriction(ctx.db, {
        id: restrictedPage.pageId,
        workspaceId: ctx.workspaceId,
        spaceId: restrictedPage.spaceId,
      });

      const memberPage = await createPage(ctx, { member: true });
      // tf=1 in a long document: the lowest BM25 score of the whole matching
      // corpus, so the member candidate sits behind every restricted row.
      await publishPage(ctx, memberPage.pageId, [
        {
          text: `alpha ${'padding token '.repeat(60)}`,
          embedding: null,
        },
      ]);

      const evidence = await retrieve(ctx, 'keyword', {
        query: 'alpha',
        limit: 1,
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0].key.pageId).toBe(memberPage.pageId);
      expect(pageAccessId).toBeTruthy();
    });
  });

  it('skips the rerank stage entirely in skipRerank mode', async () => {
    const rerankPort = new FixtureRerankPort((_query, passages) =>
      passages.map(() => 0.9),
    );
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'alpha beta gamma', embedding: null },
          { text: 'alpha delta', embedding: null },
        ]);
        await setWorkspaceSettings(ctx, {
          rag: {
            retrievalSettings: {
              rerankModel: 'rerank-model',
              rerankTopK: 2,
            },
          },
        });

        const result = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'hybrid', limit: 10, skipRerank: true },
        );
        expect(rerankPort.calls).toBe(0);
        expect(result.evidence.map((item) => item.text)).toEqual([
          'alpha delta',
          'alpha beta gamma',
        ]);
        expect(result.retrieval).toEqual({
          mode: 'hybrid',
          rerankStatus: 'not_applicable',
        });
      },
      {},
      rerankPort,
    );
  });

  it('activates rerank through a non-blank rerankModel override', async () => {
    const rerankPort = new FixtureRerankPort((_query, passages) =>
      passages.map(() => 0.9),
    );
    await setup(
      async (ctx) => {
        const { pageId } = await createPage(ctx, { member: true });
        await publishPage(ctx, pageId, [
          { text: 'alpha beta gamma', embedding: null },
          { text: 'alpha delta', embedding: null },
        ]);

        // No stored rerank model: without the override the fused order stands
        // and the port is never consulted.
        const plain = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          { query: 'alpha', mode: 'hybrid', limit: 10 },
        );
        expect(rerankPort.calls).toBe(0);
        expect(plain.retrieval.rerankStatus).toBe('not_configured');

        // A non-blank override selects the model server-side and reranks.
        const overridden = await ctx.retriever.retrieve(
          { userId: ctx.actorUserId, workspaceId: ctx.workspaceId },
          {
            query: 'alpha',
            mode: 'hybrid',
            limit: 10,
            overrides: { rerankModel: 'override-model' },
          },
        );
        expect(rerankPort.calls).toBe(1);
        expect(rerankPort.receivedModels).toEqual(['override-model']);
        expect(overridden.retrieval.rerankStatus).toBe('applied');
      },
      {},
      rerankPort,
    );
  });
});
