import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { toInputRevision } from '../contracts';
import { RagStateRepository } from '../persistence/rag-state.repository';
import {
  ragTestDbConfigured,
  seedWorkspace,
  withRagTestDb,
} from '../persistence/rag-test-db';
import { RagGenerationStore } from './rag-generation.store';
import { RagGenerationQuery } from './rag-generation-query';

(ragTestDbConfigured ? describe : describe.skip)('RagGenerationQuery', () => {
  const DIMENSIONS = 3;

  interface SeededPage {
    pageId: string;
    spaceId: string;
  }

  interface TestContext {
    db: Kysely<DbInterface>;
    store: RagGenerationStore;
    stateRepo: RagStateRepository;
    query: RagGenerationQuery;
    workspaceId: string;
  }

  const seedPageInSpace = async (
    db: Kysely<DbInterface>,
    workspaceId: string,
    spaceId: string,
    pageId: string,
  ): Promise<void> => {
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId,
        slug: randomUUID(),
        name: 'rag-test',
      })
      .execute();
    await db
      .insertInto('pages')
      .values({
        id: pageId,
        workspaceId,
        spaceId,
        slugId: randomUUID().slice(0, 10),
      })
      .execute();
  };

  const setup = async (
    run: (ctx: TestContext) => Promise<void>,
  ): Promise<void> => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const stateRepo = new RagStateRepository(db);
      const store = new RagGenerationStore(db, stateRepo);
      const query = new RagGenerationQuery();
      await run({ db, store, stateRepo, query, workspaceId });
    });
  };

  const advance = (
    ctx: TestContext,
    pageId: string,
    operation: 'upsert' | 'delete',
    cause: 'page' | 'restore' = 'page',
  ) =>
    ctx.db
      .transaction()
      .execute((trx) =>
        ctx.stateRepo.advanceForChange(
          trx,
          { workspaceId: ctx.workspaceId, pageId },
          operation,
          cause,
        ),
      );

  const enableProfile = (ctx: TestContext, profileHash: string) =>
    ctx.db.transaction().execute((trx) =>
      ctx.stateRepo.updateWorkspaceProfile(trx, ctx.workspaceId, {
        enabled: true,
        profileId: randomUUID(),
        profileHash,
      }),
    );

  const setProfileEnabled = (
    ctx: TestContext,
    profileHash: string,
    enabled: boolean,
  ) =>
    ctx.db.transaction().execute((trx) =>
      ctx.stateRepo.updateWorkspaceProfile(trx, ctx.workspaceId, {
        enabled,
        profileId: randomUUID(),
        profileHash,
      }),
    );

  interface IndexedChunk {
    text: string;
    values: number[];
  }

  const stageAndPublish = async (
    ctx: TestContext,
    page: SeededPage,
    revision: string,
    profileHash: string,
    chunks: IndexedChunk[],
  ): Promise<string> => {
    const key = { workspaceId: ctx.workspaceId, pageId: page.pageId };
    const batch = {
      key,
      inputRevision: toInputRevision(revision),
      profileHash,
      chunks: chunks.map((chunk, ordinal) => ({
        chunkId: `${page.pageId}-r${revision}-${ordinal}`,
        ordinal,
        text: chunk.text,
        tokenCount: 8,
        locator: {
          pageId: page.pageId,
          headingPath: ['Heading'],
          start: ordinal * 20,
          end: ordinal * 20 + 20,
          offsetUnit: 'utf16' as const,
          textHash: `hash-${revision}-${ordinal}`,
        },
      })),
    };
    const embeddingBatch = {
      profileHash,
      dimensions: DIMENSIONS,
      vectors: chunks.map((chunk, ordinal) => ({
        chunkId: batch.chunks[ordinal].chunkId,
        values: chunk.values,
      })),
    };
    const { generationId } = await ctx.store.stage(batch, embeddingBatch);
    // Publication requires the persisted workspace profile to be enabled with
    // the same profileHash (foundation CAS gate).
    await enableProfile(ctx, profileHash);
    const outcome = await ctx.store.publishIfCurrent(
      key,
      toInputRevision(revision),
      profileHash,
      generationId,
    );
    expect(outcome).toBe('published');
    return generationId;
  };

  const semantic = (
    ctx: TestContext,
    params: Partial<Parameters<RagGenerationQuery['semantic']>[1]> = {},
  ) =>
    ctx.query.semantic(ctx.db, {
      workspaceId: ctx.workspaceId,
      profileHash: 'profile-a',
      values: [1, 0, 0],
      limit: 10,
      ...params,
    });

  const keyword = (
    ctx: TestContext,
    query: string,
    params: Partial<Parameters<RagGenerationQuery['keyword']>[1]> = {},
  ) =>
    ctx.query.keyword(ctx.db, {
      workspaceId: ctx.workspaceId,
      query,
      limit: 10,
      ...params,
    });

  it('returns semantic evidence ranked by cosine from the active generation', async () => {
    await setup(async (ctx) => {
      const page: SeededPage = {
        pageId: randomUUID(),
        spaceId: randomUUID(),
      };
      await seedPageInSpace(ctx.db, ctx.workspaceId, page.spaceId, page.pageId);
      await advance(ctx, page.pageId, 'upsert');

      await stageAndPublish(ctx, page, '1', 'profile-a', [
        { text: 'alpha content block', values: [1, 0, 0] },
        { text: 'beta content block', values: [0, 1, 0] },
      ]);

      const evidence = await semantic(ctx, { values: [0.95, 0.3, 0] });
      expect(evidence).toHaveLength(2);
      expect(evidence[0].text).toBe('alpha content block');
      expect(evidence[0].score.kind).toBe('cosine');
      expect(evidence[0].score.value).toBeGreaterThan(evidence[1].score.value);
      expect(evidence[0].key).toEqual({
        workspaceId: ctx.workspaceId,
        pageId: page.pageId,
      });
      expect(evidence[0].inputRevision).toBe('1');
      expect(evidence[0].locator).toMatchObject({
        pageId: page.pageId,
        headingPath: ['Heading'],
        offsetUnit: 'utf16',
      });
    });
  });

  it('hides staged work until publication and hides stale generations after a profile change', async () => {
    await setup(async (ctx) => {
      const page: SeededPage = {
        pageId: randomUUID(),
        spaceId: randomUUID(),
      };
      await seedPageInSpace(ctx.db, ctx.workspaceId, page.spaceId, page.pageId);
      await advance(ctx, page.pageId, 'upsert');

      await stageAndPublish(ctx, page, '1', 'profile-a', [
        { text: 'published visible text', values: [1, 0, 0] },
      ]);

      // Stage revision 2 without publishing: invisible to both modes.
      const key = { workspaceId: ctx.workspaceId, pageId: page.pageId };
      const staged = await ctx.store.stage(
        {
          key,
          inputRevision: toInputRevision('2'),
          profileHash: 'profile-a',
          chunks: [
            {
              chunkId: `${page.pageId}-r2-0`,
              ordinal: 0,
              text: 'staged secret text',
              tokenCount: 8,
              locator: {
                pageId: page.pageId,
                headingPath: [],
                start: 0,
                end: 10,
                offsetUnit: 'utf16',
                textHash: 'hash-2-0',
              },
            },
          ],
        },
        {
          profileHash: 'profile-a',
          dimensions: DIMENSIONS,
          vectors: [{ chunkId: `${page.pageId}-r2-0`, values: [1, 0, 0] }],
        },
      );
      expect((await semantic(ctx)).map((e) => e.text)).toEqual([
        'published visible text',
      ]);
      expect((await keyword(ctx, 'secret')).map((e) => e.text)).toEqual([]);

      await advance(ctx, page.pageId, 'upsert');
      const outcome = await ctx.store.publishIfCurrent(
        key,
        toInputRevision('2'),
        'profile-a',
        staged.generationId,
      );
      expect(outcome).toBe('published');
      expect((await keyword(ctx, 'secret')).map((e) => e.text)).toEqual([
        'staged secret text',
      ]);
      expect((await keyword(ctx, 'published')).map((e) => e.text)).toEqual([]);

      // A profile change invalidates mismatched retrieval immediately.
      await ctx.db.transaction().execute((trx) =>
        ctx.stateRepo.updateWorkspaceProfile(trx, ctx.workspaceId, {
          enabled: true,
          profileId: randomUUID(),
          profileHash: 'profile-b',
        }),
      );
      expect(await semantic(ctx)).toEqual([]);
      expect(await semantic(ctx, { profileHash: 'profile-b' })).toEqual([]);
      expect(await keyword(ctx, 'secret')).toEqual([]);
    });
  });

  it('returns no evidence for deleted sources or a disabled profile', async () => {
    await setup(async (ctx) => {
      const page: SeededPage = {
        pageId: randomUUID(),
        spaceId: randomUUID(),
      };
      await seedPageInSpace(ctx.db, ctx.workspaceId, page.spaceId, page.pageId);
      await advance(ctx, page.pageId, 'upsert');
      await stageAndPublish(ctx, page, '1', 'profile-a', [
        { text: 'alpha content block', values: [1, 0, 0] },
      ]);
      expect((await semantic(ctx)).length).toBe(1);
      expect((await keyword(ctx, 'alpha')).length).toBe(1);

      await advance(ctx, page.pageId, 'delete');
      expect(await semantic(ctx)).toEqual([]);
      expect(await keyword(ctx, 'alpha')).toEqual([]);

      // After restore the old published generation is stale: the active
      // generation must match the new desired revision.
      await advance(ctx, page.pageId, 'upsert', 'restore');
      expect(await semantic(ctx)).toEqual([]);

      await stageAndPublish(ctx, page, '3', 'profile-a', [
        { text: 'alpha content block', values: [1, 0, 0] },
      ]);
      expect((await semantic(ctx)).length).toBe(1);

      await setProfileEnabled(ctx, 'profile-a', false);
      expect(await semantic(ctx)).toEqual([]);
      expect(await keyword(ctx, 'alpha')).toEqual([]);
    });
  });

  it('scopes semantic and keyword evidence by space, pages and limit', async () => {
    await setup(async (ctx) => {
      const spaceOne = randomUUID();
      const spaceTwo = randomUUID();
      const pageOne: SeededPage = {
        pageId: randomUUID(),
        spaceId: spaceOne,
      };
      const pageTwo: SeededPage = {
        pageId: randomUUID(),
        spaceId: spaceTwo,
      };
      await seedPageInSpace(ctx.db, ctx.workspaceId, spaceOne, pageOne.pageId);
      await seedPageInSpace(ctx.db, ctx.workspaceId, spaceTwo, pageTwo.pageId);
      await advance(ctx, pageOne.pageId, 'upsert');
      await advance(ctx, pageTwo.pageId, 'upsert');

      await stageAndPublish(ctx, pageOne, '1', 'profile-a', [
        { text: 'alpha content block', values: [1, 0, 0] },
      ]);
      await stageAndPublish(ctx, pageTwo, '1', 'profile-a', [
        { text: 'alpha content block', values: [1, 0, 0] },
      ]);

      const inSpaceOne = await semantic(ctx, { spaceId: spaceOne });
      expect(inSpaceOne).toHaveLength(1);
      expect(inSpaceOne[0].key.pageId).toBe(pageOne.pageId);

      const onlyPageTwo = await keyword(ctx, 'alpha', {
        pageIds: [pageTwo.pageId],
      });
      expect(onlyPageTwo).toHaveLength(1);
      expect(onlyPageTwo[0].key.pageId).toBe(pageTwo.pageId);

      const limited = await semantic(ctx, { limit: 1 });
      expect(limited).toHaveLength(1);
    });
  });

  it('ranks keyword evidence lexically without touching embeddings', async () => {
    await setup(async (ctx) => {
      const page: SeededPage = {
        pageId: randomUUID(),
        spaceId: randomUUID(),
      };
      await seedPageInSpace(ctx.db, ctx.workspaceId, page.spaceId, page.pageId);
      await advance(ctx, page.pageId, 'upsert');

      await stageAndPublish(ctx, page, '1', 'profile-a', [
        { text: 'gravity waves detection apparatus', values: [1, 0, 0] },
        { text: 'quantum entanglement experiments', values: [0, 1, 0] },
      ]);

      const evidence = await keyword(ctx, 'gravity waves');
      expect(evidence).toHaveLength(1);
      expect(evidence[0].text).toBe('gravity waves detection apparatus');
      expect(evidence[0].score.kind).toBe('lexical');
      expect(evidence[0].score.value).toBeGreaterThan(0);

      expect(await keyword(ctx, 'nonexistenttoken')).toEqual([]);
      expect(await keyword(ctx, '')).toEqual([]);
    });
  });

  it('rejects a non-positive limit', async () => {
    await setup(async (ctx) => {
      await expect(semantic(ctx, { limit: 0 })).rejects.toThrow('limit');
      await expect(keyword(ctx, 'alpha', { limit: -1 })).rejects.toThrow(
        'limit',
      );
    });
  });
});
