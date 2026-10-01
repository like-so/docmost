import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import {
  Chunk,
  ChunkBatch,
  ChunkLocator,
  EmbeddingBatchResult,
  toInputRevision,
} from '../contracts';
import { RagStateRepository } from '../persistence/rag-state.repository';
import {
  countRows,
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from '../persistence/rag-test-db';
import { RagGenerationStore } from './rag-generation.store';
import { RagGenerationQuery } from './rag-generation-query';

(ragTestDbConfigured ? describe : describe.skip)('RagGenerationStore', () => {
  const DIMENSIONS = 3;

  interface TestContext {
    db: Kysely<DbInterface>;
    store: RagGenerationStore;
    stateRepo: RagStateRepository;
    query: RagGenerationQuery;
    key: { workspaceId: string; pageId: string };
  }

  const setup = async (
    run: (ctx: TestContext) => Promise<void>,
  ): Promise<void> => {
    await withRagTestDb(async (db) => {
      const workspaceId = randomUUID();
      await seedWorkspace(db, workspaceId);
      const key = { workspaceId, pageId: randomUUID() };
      await seedPage(db, workspaceId, key.pageId);
      const stateRepo = new RagStateRepository(db);
      const store = new RagGenerationStore(db, stateRepo);
      const query = new RagGenerationQuery();
      await run({ db, store, stateRepo, query, key });
    });
  };

  const advance = (
    ctx: TestContext,
    operation: 'upsert' | 'delete',
    cause: 'page' | 'restore' = 'page',
  ) =>
    ctx.db
      .transaction()
      .execute((trx) =>
        ctx.stateRepo.advanceForChange(trx, ctx.key, operation, cause),
      );

  const enableProfile = (ctx: TestContext, profileHash: string) =>
    ctx.db.transaction().execute((trx) =>
      ctx.stateRepo.updateWorkspaceProfile(trx, ctx.key.workspaceId, {
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
      ctx.stateRepo.updateWorkspaceProfile(trx, ctx.key.workspaceId, {
        enabled,
        profileId: randomUUID(),
        profileHash,
      }),
    );

  const makeChunk = (
    pageId: string,
    revision: string,
    ordinal: number,
    text: string,
  ): Chunk => {
    const locator: ChunkLocator = {
      pageId,
      headingPath: ['Section'],
      start: ordinal * 10,
      end: ordinal * 10 + 10,
      offsetUnit: 'utf16',
      textHash: `hash-${revision}-${ordinal}`,
    };
    return {
      chunkId: `${pageId}-r${revision}-${ordinal}`,
      ordinal,
      text,
      tokenCount: 4,
      locator,
    };
  };

  interface StageSpec {
    revision: string;
    profileHash: string;
    texts: string[];
    vectors?: number[][];
  }

  const makeBatch = (
    ctx: TestContext,
    spec: StageSpec,
  ): { batch: ChunkBatch; embeddingBatch: EmbeddingBatchResult } => {
    const chunks = spec.texts.map((text, ordinal) =>
      makeChunk(ctx.key.pageId, spec.revision, ordinal, text),
    );
    const vectors =
      spec.vectors ??
      chunks.map((_, ordinal) => {
        const values = new Array(DIMENSIONS).fill(0);
        values[ordinal % DIMENSIONS] = 1;
        return values;
      });
    return {
      batch: {
        key: ctx.key,
        inputRevision: toInputRevision(spec.revision),
        profileHash: spec.profileHash,
        chunks,
      },
      embeddingBatch: {
        profileHash: spec.profileHash,
        dimensions: DIMENSIONS,
        vectors: chunks.map((chunk, i) => ({
          chunkId: chunk.chunkId,
          values: vectors[i],
        })),
      },
    };
  };

  const stage = async (ctx: TestContext, spec: StageSpec) => {
    const { batch, embeddingBatch } = makeBatch(ctx, spec);
    const result = await ctx.store.stage(batch, embeddingBatch);
    return { ...result, batch, embeddingBatch };
  };

  const stageAndPublish = async (
    ctx: TestContext,
    spec: StageSpec,
  ): Promise<{ generationId: string }> => {
    const { generationId } = await stage(ctx, spec);
    await enableProfile(ctx, spec.profileHash);
    const outcome = await ctx.store.publishIfCurrent(
      ctx.key,
      toInputRevision(spec.revision),
      spec.profileHash,
      generationId,
    );
    expect(outcome).toBe('published');
    return { generationId };
  };

  const listGenerations = async (ctx: TestContext) =>
    ctx.db
      .selectFrom('ragGenerations')
      .selectAll()
      .where('workspaceId', '=', ctx.key.workspaceId)
      .where('pageId', '=', ctx.key.pageId)
      .orderBy('inputRevision', 'asc')
      .execute();

  const stateOf = async (ctx: TestContext) =>
    ctx.stateRepo.find(ctx.db, ctx.key);

  it('stages chunks with embeddings that are invisible to both query modes', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const { generationId, chunkCount } = await stage(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['alpha text', 'beta text'],
      });
      expect(chunkCount).toBe(2);

      const generations = await listGenerations(ctx);
      expect(generations).toHaveLength(1);
      expect(generations[0].id).toBe(generationId);
      expect(generations[0].status).toBe('staged');
      expect(generations[0].chunkCount).toBe(2);

      const chunks = await ctx.db
        .selectFrom('ragChunks')
        .selectAll()
        .where('generationId', '=', generationId)
        .orderBy('ordinal', 'asc')
        .execute();
      expect(chunks).toHaveLength(2);
      expect(chunks[0].embedding).toEqual([1, 0, 0]);
      expect(chunks[1].embedding).toEqual([0, 1, 0]);
      expect(chunks[0].embeddingDimensions).toBe(DIMENSIONS);

      await enableProfile(ctx, 'profile-a');
      const semantic = await ctx.query.semantic(ctx.db, {
        workspaceId: ctx.key.workspaceId,
        profileHash: 'profile-a',
        values: [1, 0, 0],
        limit: 10,
      });
      const keyword = await ctx.query.keyword(ctx.db, {
        workspaceId: ctx.key.workspaceId,
        query: 'alpha',
        limit: 10,
      });
      expect(semantic).toEqual([]);
      expect(keyword).toEqual([]);
    });
  });

  it('resolves a duplicate stage to the existing generation', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const first = await stage(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['alpha text'],
      });
      const duplicate = await ctx.store.stage(
        first.batch,
        first.embeddingBatch,
      );
      expect(duplicate.generationId).toBe(first.generationId);
      expect(duplicate.chunkCount).toBe(1);
      expect(await countRows(ctx.db, 'ragSourceState')).toBe(1);
      expect(await listGenerations(ctx)).toHaveLength(1);
    });
  });

  it('resolves concurrent duplicate stages to one generation', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const { batch, embeddingBatch } = makeBatch(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['alpha text', 'beta text'],
      });
      const results = await Promise.all([
        ctx.store.stage(batch, embeddingBatch),
        ctx.store.stage(batch, embeddingBatch),
      ]);
      expect(results[0].generationId).toBe(results[1].generationId);
      expect(await listGenerations(ctx)).toHaveLength(1);
    });
  });

  it('rejects an embedding batch with a mismatched profile hash without writing', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const { batch, embeddingBatch } = makeBatch(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['alpha text'],
      });
      expect.assertions(2);
      await expect(
        ctx.store.stage(batch, { ...embeddingBatch, profileHash: 'profile-b' }),
      ).rejects.toThrow('profileHash');
      expect(await listGenerations(ctx)).toHaveLength(0);
    });
  });

  it('rejects embedding batches with wrong dimensions or degenerate vectors', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const { batch, embeddingBatch } = makeBatch(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['alpha text'],
      });

      await expect(
        ctx.store.stage(batch, {
          ...embeddingBatch,
          vectors: [{ chunkId: batch.chunks[0].chunkId, values: [1, 0] }],
        }),
      ).rejects.toThrow('dimensions');

      await expect(
        ctx.store.stage(batch, {
          ...embeddingBatch,
          vectors: [{ chunkId: batch.chunks[0].chunkId, values: [0, 0, 0] }],
        }),
      ).rejects.toThrow('all zeros');

      await expect(
        ctx.store.stage(batch, {
          ...embeddingBatch,
          vectors: [
            { chunkId: batch.chunks[0].chunkId, values: [1, 0, Number.NaN] },
          ],
        }),
      ).rejects.toThrow('non-finite');

      expect(await listGenerations(ctx)).toHaveLength(0);
    });
  });

  it('rejects embedding batches that do not cover exactly the chunk batch', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const { batch, embeddingBatch } = makeBatch(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['alpha text', 'beta text'],
      });

      await expect(
        ctx.store.stage(batch, {
          ...embeddingBatch,
          vectors: [embeddingBatch.vectors[0]],
        }),
      ).rejects.toThrow('missing a vector');

      await expect(
        ctx.store.stage(
          { ...batch, chunks: batch.chunks.slice(0, 1) },
          embeddingBatch,
        ),
      ).rejects.toThrow('outside the chunk batch');

      expect(await listGenerations(ctx)).toHaveLength(0);
    });
  });

  it('publishes atomically, retires older generations, and keeps newer staged work', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      await stageAndPublish(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });

      await advance(ctx, 'upsert');
      const second = await stage(ctx, {
        revision: '2',
        profileHash: 'profile-a',
        texts: ['revision two'],
      });
      // Another worker stages an even newer revision while revision 2
      // publishes; revision-bounded retirement must not touch it.
      const third = await stage(ctx, {
        revision: '3',
        profileHash: 'profile-a',
        texts: ['revision three'],
      });

      const outcome = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('2'),
        'profile-a',
        second.generationId,
      );
      expect(outcome).toBe('published');

      const generations = await listGenerations(ctx);
      expect(generations.map((row) => row.inputRevision)).toEqual(['2', '3']);
      expect(generations[0].status).toBe('published');
      expect(generations[0].publishedAt).not.toBeNull();
      expect(generations[1].id).toBe(third.generationId);
      expect(generations[1].status).toBe('staged');

      const state = await stateOf(ctx);
      expect(state?.publishedGenerationId).toBe(second.generationId);
      expect(state?.publishedInputRevision).toBe('2');
    });
  });

  it('reports superseded for a stale publish and preserves the newer pointer', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      await stageAndPublish(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });

      await advance(ctx, 'upsert');
      const second = await stageAndPublish(ctx, {
        revision: '2',
        profileHash: 'profile-a',
        texts: ['revision two'],
      });

      // A late duplicate job for revision 1 can neither publish nor clear
      // the newer worker's status.
      const staleGeneration = await ctx.db
        .selectFrom('ragGenerations')
        .select('id')
        .where('pageId', '=', ctx.key.pageId)
        .where('inputRevision', '=', '1')
        .executeTakeFirst();
      expect(staleGeneration).toBeUndefined();

      const outcome = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        randomUUID(),
      );
      expect(outcome).toBe('superseded');

      const state = await stateOf(ctx);
      expect(state?.publishedGenerationId).toBe(second.generationId);
      expect(state?.publishedInputRevision).toBe('2');
    });
  });

  it('keeps the staged generation and old pointer when a newer edit lands while embedding', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const first = await stage(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });
      await enableProfile(ctx, 'profile-a');

      // A newer edit commits before the worker publishes.
      await advance(ctx, 'upsert');

      const outcome = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        first.generationId,
      );
      expect(outcome).toBe('superseded');

      const state = await stateOf(ctx);
      expect(state?.publishedGenerationId).toBeNull();
      const generations = await listGenerations(ctx);
      expect(generations).toHaveLength(1);
      expect(generations[0].status).toBe('staged');

      await enableProfile(ctx, 'profile-a');
      const after = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        first.generationId,
      );
      expect(after).toBe('superseded');
    });
  });

  it('reports deleted for a publish after the source tombstone', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const first = await stage(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });
      await enableProfile(ctx, 'profile-a');

      await advance(ctx, 'delete');

      const outcome = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        first.generationId,
      );
      expect(outcome).toBe('deleted');

      const state = await stateOf(ctx);
      expect(state?.sourceStatus).toBe('deleted');
      expect(state?.publishedGenerationId).toBeNull();
      expect(await listGenerations(ctx)).toHaveLength(1);
    });
  });

  it('reports disabled while the workspace profile is disabled', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const first = await stage(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });
      await enableProfile(ctx, 'profile-a');
      await setProfileEnabled(ctx, 'profile-a', false);

      const outcome = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        first.generationId,
      );
      expect(outcome).toBe('disabled');
      expect((await stateOf(ctx))?.publishedGenerationId).toBeNull();
    });
  });

  it('treats a duplicate publish after success as idempotent', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const { generationId } = await stageAndPublish(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });

      const again = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        generationId,
      );
      expect(again).toBe('published');

      const generations = await listGenerations(ctx);
      expect(generations).toHaveLength(1);
      expect(generations[0].status).toBe('published');
      expect((await stateOf(ctx))?.publishedGenerationId).toBe(generationId);
    });
  });

  it('purges older generations while preserving the current generation', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const first = await stageAndPublish(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });

      // Cleanup for the current revision keeps the active generation.
      await ctx.store.purge(ctx.key, toInputRevision('1'));
      let generations = await listGenerations(ctx);
      expect(generations.map((row) => row.id)).toEqual([first.generationId]);

      await advance(ctx, 'upsert');
      const second = await stageAndPublish(ctx, {
        revision: '2',
        profileHash: 'profile-a',
        texts: ['revision two'],
      });
      const third = await stage(ctx, {
        revision: '3',
        profileHash: 'profile-a',
        texts: ['revision three'],
      });

      await ctx.store.purge(ctx.key, toInputRevision('2'));
      generations = await listGenerations(ctx);
      expect(generations.map((row) => row.id)).toEqual([
        second.generationId,
        third.generationId,
      ]);
    });
  });

  it('removes the stale published generation in delete cleanup but not newer work', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      await stageAndPublish(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });

      await advance(ctx, 'delete');
      await ctx.store.purge(ctx.key, toInputRevision('2'));
      expect(await listGenerations(ctx)).toHaveLength(0);

      // A restored generation at a newer revision is never touched by an
      // older purge bound.
      await advance(ctx, 'upsert', 'restore');
      const restored = await stage(ctx, {
        revision: '3',
        profileHash: 'profile-a',
        texts: ['restored content'],
      });
      await ctx.store.purge(ctx.key, toInputRevision('2'));
      const generations = await listGenerations(ctx);
      expect(generations.map((row) => row.id)).toEqual([restored.generationId]);
    });
  });

  it('never lets a late publish after deletion resurrect content', async () => {
    await setup(async (ctx) => {
      await advance(ctx, 'upsert');
      const first = await stage(ctx, {
        revision: '1',
        profileHash: 'profile-a',
        texts: ['revision one'],
      });
      await enableProfile(ctx, 'profile-a');
      const published = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        first.generationId,
      );
      expect(published).toBe('published');

      await advance(ctx, 'delete');
      await ctx.store.purge(ctx.key, toInputRevision('2'));

      // The purged generation row is gone: the late publish reports the
      // terminal deleted outcome instead of reviving anything.
      const late = await ctx.store.publishIfCurrent(
        ctx.key,
        toInputRevision('1'),
        'profile-a',
        first.generationId,
      );
      expect(late).toBe('deleted');
      expect(await listGenerations(ctx)).toHaveLength(0);
      expect((await stateOf(ctx))?.sourceStatus).toBe('deleted');
    });
  });
});
