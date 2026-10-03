import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  ChunkLocator,
  RagError,
  RagEvidence,
  toInputRevision,
} from '../contracts';

export interface RagQueryScope {
  workspaceId: string;
  spaceId?: string;
  pageIds?: string[];
  limit: number;
}

export interface SemanticQueryParams extends RagQueryScope {
  /** Query embedding from the SAME profileHash as the active generation. */
  profileHash: string;
  values: number[];
}

export interface KeywordQueryParams extends RagQueryScope {
  query: string;
}

interface ActiveChunkRow {
  chunkId: string;
  workspaceId: string;
  pageId: string;
  text: string;
  locator: unknown;
  embedding: unknown;
  inputRevision: string;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }
}

/**
 * A query embedding must be comparable to stored chunk vectors: non-empty,
 * finite and not all zeros. Otherwise cosine similarity silently degrades
 * (truncated comparison, zero or non-finite scores) instead of rejecting
 * the invalid input.
 */
function assertQueryEmbedding(values: number[]): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RagError(
      'EMBEDDING_RESPONSE_INVALID',
      'Query embedding must be a non-empty vector',
    );
  }
  let nonzero = false;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'Query embedding contains a non-finite value',
      );
    }
    if (value !== 0) nonzero = true;
  }
  if (!nonzero) {
    throw new RagError(
      'EMBEDDING_RESPONSE_INVALID',
      'Query embedding is all zeros',
    );
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Query primitives over published generations. Evidence comes only from the
 * ACTIVE generation of a live source: the generation row is published, the
 * source state is live with desiredInputRevision == publishedInputRevision ==
 * generation.inputRevision, the pointer references exactly that generation,
 * and the enabled workspace profile hash matches the generation profile hash.
 * Staged, superseded, disabled and deleted sources are therefore invisible.
 *
 * Embeddings are JSONB arrays (no pgvector): semantic ranking fetches the
 * active chunks in scope and computes cosine similarity in-process. Keyword
 * ranking is Postgres full-text search with the 'simple' configuration, a
 * separate explicit mode with no fusion weighting.
 *
 * Authorization rechecking of the returned pages belongs to the retrieval
 * component; these primitives only enforce workspace scope and the
 * active-generation contract.
 */
@Injectable()
export class RagGenerationQuery {
  private activeChunks(
    db: KyselyDB,
    workspaceId: string,
    scope: RagQueryScope,
  ) {
    let query = db
      .selectFrom('ragChunks as c')
      .innerJoin('ragGenerations as g', 'g.id', 'c.generationId')
      .innerJoin('ragSourceState as s', (join) =>
        join
          .onRef('s.workspaceId', '=', 'g.workspaceId')
          .onRef('s.pageId', '=', 'g.pageId'),
      )
      .innerJoin('ragWorkspaceProfile as wp', 'wp.workspaceId', 'g.workspaceId')
      .innerJoin('pages as p', 'p.id', 'c.pageId')
      .where('c.workspaceId', '=', workspaceId)
      .where('p.workspaceId', '=', workspaceId)
      .where('g.status', '=', 'published')
      .where('s.sourceStatus', '=', 'live')
      .whereRef('s.desiredInputRevision', '=', 'g.inputRevision')
      .whereRef('s.publishedInputRevision', '=', 'g.inputRevision')
      .whereRef('s.publishedGenerationId', '=', 'g.id')
      .where('wp.enabled', '=', true)
      .whereRef('wp.profileHash', '=', 'g.profileHash');
    if (scope.spaceId) {
      query = query.where('p.spaceId', '=', scope.spaceId);
    }
    if (scope.pageIds && scope.pageIds.length > 0) {
      query = query.where('c.pageId', 'in', scope.pageIds);
    }
    return query;
  }

  private toEvidence(
    row: ActiveChunkRow,
    score: RagEvidence['score'],
  ): RagEvidence {
    return {
      chunkId: row.chunkId,
      key: { workspaceId: row.workspaceId, pageId: row.pageId },
      inputRevision: toInputRevision(row.inputRevision),
      text: row.text,
      locator: row.locator as ChunkLocator,
      score,
    };
  }

  async semantic(
    db: KyselyDB,
    params: SemanticQueryParams,
  ): Promise<RagEvidence[]> {
    assertLimit(params.limit);
    assertQueryEmbedding(params.values);

    const rows = await this.activeChunks(db, params.workspaceId, params)
      .where('g.profileHash', '=', params.profileHash)
      .select([
        'c.id as chunkId',
        'c.workspaceId',
        'c.pageId',
        'c.text',
        'c.locator',
        'c.embedding',
        'g.inputRevision',
      ])
      .execute();

    const scored: { row: ActiveChunkRow; value: number }[] = [];
    for (const row of rows) {
      const embedding = row.embedding;
      if (!Array.isArray(embedding)) continue;
      // Vectors of different dimensions are not comparable; comparing the
      // shared prefix would silently score a truncated projection.
      if ((embedding as number[]).length !== params.values.length) continue;
      const value = cosineSimilarity(embedding as number[], params.values);
      if (!Number.isFinite(value)) continue;
      scored.push({ row: row as ActiveChunkRow, value });
    }

    scored.sort((a, b) => b.value - a.value);
    return scored
      .slice(0, params.limit)
      .map(({ row, value }) => this.toEvidence(row, { kind: 'cosine', value }));
  }

  async keyword(
    db: KyselyDB,
    params: KeywordQueryParams,
  ): Promise<RagEvidence[]> {
    assertLimit(params.limit);

    const rows = await this.activeChunks(db, params.workspaceId, params)
      .where(
        sql<boolean>`to_tsvector('simple', c.text) @@ websearch_to_tsquery('simple', ${params.query})`,
      )
      .select([
        'c.id as chunkId',
        'c.workspaceId',
        'c.pageId',
        'c.text',
        'c.locator',
        'g.inputRevision',
        sql<number>`ts_rank(to_tsvector('simple', c.text), websearch_to_tsquery('simple', ${params.query}))`.as(
          'lexicalScore',
        ),
      ])
      .orderBy(
        sql`ts_rank(to_tsvector('simple', c.text), websearch_to_tsquery('simple', ${params.query})) desc`,
      )
      .limit(params.limit)
      .execute();

    return rows.map((row) =>
      this.toEvidence(row as unknown as ActiveChunkRow, {
        kind: 'keyword',
        value: Number(
          (row as unknown as { lexicalScore: number }).lexicalScore,
        ),
      }),
    );
  }
}
