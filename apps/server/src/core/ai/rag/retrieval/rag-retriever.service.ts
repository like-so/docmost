import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { RawBuilder, sql } from 'kysely';
import {
  EmbeddingPort,
  IndexProfile,
  RagActor,
  RagEvidence,
  RagError,
  RagProfileResolver,
  RagRetrievalMode,
  RagRerankStatus,
  RagRetriever,
  RagRetrieverQuery,
  RagRetrieveResult,
  RagRerankPort,
  RAG_EMBEDDING_PORT,
  RAG_PROFILE_RESOLVER,
  RAG_RERANK_PORT,
  toInputRevision,
} from '../contracts';
import { RagStateRepository } from '../persistence/rag-state.repository';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { cosineSimilarity } from '../index-store/rag-generation-query';
import {
  OVER_RETRIEVAL_CAP,
  OVER_RETRIEVAL_FACTOR,
  OVER_RETRIEVAL_FLOOR,
  RERANK_POOL_FLOOR,
  effectiveIndexingStrategy,
  parseRetrievalSettings,
} from './retrieval-config';
import {
  BM25_B,
  BM25_K1,
  Bm25CorpusStats,
  bm25Score,
  parseTsvectorText,
} from './bm25';
import {
  FusionCandidate,
  fuseHybrid,
  fuseKeywordOnly,
  fuseVectorOnly,
} from './fusion';
import { applyRerankStage, buildModelPassage } from './rerank';

export const RETRIEVAL_LIMIT_MAX = 50;

interface CandidateRow {
  chunkId: string;
  workspaceId: string;
  pageId: string;
  spaceId: string;
  text: string;
  locator: unknown;
  embedding: unknown;
  lexicalRank: number | null;
  generationInputRevision: string;
}

interface KeywordCandidateRow extends CandidateRow {
  tsvectorText: string;
}

/**
 * Authorized evidence boundary (docmost-rag-v1 contract 12). Only chunks from
 * the published generation pointer that still matches the current desired
 * revision, current workspace profile and a live, nondeleted source are
 * eligible; current Docmost authorization (space membership plus page-level
 * restrictions) is rechecked before any text is returned.
 *
 * Hybrid retrieval (docmost-rag-v1 contract 12, ported from Tencent/WeKnora
 * bccb4b1) runs independent dense and keyword recall routes and fuses them
 * with weighted RRF, then optionally reranks. The over-retrieval pool is
 * min(max(matchCount*5, 50) * numberOfKBs, 500); Docmost RAG has a single
 * workspace-wide index per profile, so numberOfKBs is 1 (a spaceId- or
 * pageIds-scoped search narrows one KB scope, it does not add one).
 */
@Injectable()
export class RagRetrieverService implements RagRetriever {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly stateRepository: RagStateRepository,
    @Inject(RAG_PROFILE_RESOLVER)
    private readonly profileResolver: RagProfileResolver,
    @Inject(RAG_EMBEDDING_PORT) private readonly embeddingPort: EmbeddingPort,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    @Optional()
    @Inject(RAG_RERANK_PORT)
    private readonly rerankPort?: RagRerankPort,
  ) {}

  async retrieve(
    actor: RagActor,
    query: RagRetrieverQuery,
  ): Promise<RagRetrieveResult> {
    const trimmedQuery = query.query.trim();
    if (trimmedQuery.length < 1) {
      return this.emptyResult(query.mode);
    }
    const limit = Math.min(
      Math.max(1, Math.trunc(query.limit)),
      RETRIEVAL_LIMIT_MAX,
    );

    const profileRow = await this.stateRepository.findWorkspaceProfile(
      this.db,
      actor.workspaceId,
    );
    if (!profileRow?.enabled || !profileRow.profileHash) {
      return this.emptyResult(query.mode);
    }

    const strategy = effectiveIndexingStrategy(
      await this.readStoredIndexProfileConfig(actor.workspaceId),
    );

    if (query.mode === 'semantic') {
      if (!strategy.vectorEnabled) return this.emptyResult(query.mode);
      const scored = await this.retrieveSemantic(
        actor,
        trimmedQuery,
        query,
        profileRow.profileHash,
        null,
        limit,
      );
      return {
        evidence: scored,
        retrieval: { mode: query.mode, rerankStatus: 'not_applicable' },
      };
    }
    if (query.mode === 'keyword') {
      if (!strategy.keywordEnabled) return this.emptyResult(query.mode);
      const scored = await this.retrieveKeyword(
        actor,
        trimmedQuery,
        query,
        profileRow.profileHash,
        limit,
        limit,
      );
      return {
        evidence: scored,
        retrieval: { mode: query.mode, rerankStatus: 'not_applicable' },
      };
    }

    const { evidence: scored, rerankStatus } = await this.retrieveHybrid(
      actor,
      trimmedQuery,
      query,
      profileRow.profileHash,
      strategy,
      limit,
    );
    return { evidence: scored, retrieval: { mode: query.mode, rerankStatus } };
  }

  private emptyResult(mode: RagRetrievalMode): RagRetrieveResult {
    return {
      evidence: [],
      retrieval: { mode, rerankStatus: 'not_applicable' },
    };
  }

  /**
   * Hybrid pipeline: independent dense and keyword recall over the
   * over-retrieval pool, weighted-RRF fusion, then the optional rerank stage
   * when a rerank model is configured. Without a rerank model the fused order
   * is returned unchanged (reference NoModel outcome).
   */
  private async retrieveHybrid(
    actor: RagActor,
    trimmedQuery: string,
    query: RagRetrieverQuery,
    profileHash: string,
    strategy: { vectorEnabled: boolean; keywordEnabled: boolean },
    limit: number,
  ): Promise<{ evidence: RagEvidence[]; rerankStatus: RagRerankStatus }> {
    if (!strategy.vectorEnabled && !strategy.keywordEnabled) {
      return { evidence: [], rerankStatus: 'not_applicable' };
    }
    // knowledgebase_search.go over-retrieval budget; numberOfKBs = 1 (see the
    // class doc).
    const pool = Math.min(
      Math.max(limit * OVER_RETRIEVAL_FACTOR, OVER_RETRIEVAL_FLOOR),
      OVER_RETRIEVAL_CAP,
    );

    let vector: RagEvidence[] = [];
    if (strategy.vectorEnabled) {
      vector = await this.retrieveSemantic(
        actor,
        trimmedQuery,
        query,
        profileHash,
        pool,
        pool,
      );
    }
    let keyword: RagEvidence[] = [];
    if (strategy.keywordEnabled) {
      keyword = await this.retrieveKeyword(
        actor,
        trimmedQuery,
        query,
        profileHash,
        pool,
        pool,
      );
    }

    let fused: FusionCandidate[];
    if (vector.length === 0 && keyword.length === 0) {
      return { evidence: [], rerankStatus: 'not_applicable' };
    } else if (keyword.length === 0) {
      fused = fuseVectorOnly(vector);
    } else if (vector.length === 0) {
      fused = fuseKeywordOnly(keyword);
    } else {
      fused = fuseHybrid(vector, keyword);
    }

    const stored = (await this.readWorkspaceSettings(
      actor.workspaceId,
      'retrievalSettings',
    )) as Record<string, unknown>;
    const settings = parseRetrievalSettings({
      ...stored,
      ...(query.overrides ?? {}),
    });

    if (!settings.rerankModel || !this.rerankPort || fused.length === 0) {
      return {
        evidence: fused.slice(0, limit).map((candidate) => candidate.evidence),
        rerankStatus: 'not_configured',
      };
    }

    // HybridSearchWithRerank: the rerank pool is the best max(rerankTopK, 50)
    // fused candidates; the stage output is bounded by rerankTopK.
    const poolCandidates = fused
      .slice(0, Math.max(settings.rerankTopK, RERANK_POOL_FLOOR))
      .map((candidate) => candidate.evidence);
    const passages = poolCandidates.map((evidence) =>
      buildModelPassage(evidence),
    );
    // A failing or missing rerank model degrades to the fused order, not a
    // failed retrieval (reference NoModel outcome is recorded as a status).
    let modelScores: number[] | null = null;
    try {
      modelScores = await this.rerankPort.rerank(
        actor.workspaceId,
        settings.rerankModel,
        trimmedQuery,
        passages,
      );
    } catch {
      modelScores = null;
    }
    const rerankStatus: RagRerankStatus = modelScores ? 'applied' : 'failed';
    const reranked = applyRerankStage({
      candidates: poolCandidates,
      modelScores,
      threshold: settings.rerankThreshold,
      topK: settings.rerankTopK,
      explicitScope: Boolean(query.spaceId || query.pageIds?.length),
    });
    return {
      evidence: reranked.evidence.slice(0, limit),
      rerankStatus,
    };
  }

  /**
   * Dense recall: embeds the query through the real EmbeddingPort and ranks
   * by cosine similarity against the stored chunk vectors. It is never a
   * rerank of lexical hits: candidates without a usable vector are dropped.
   * A non-null pool cap slices the best cosine scores and applies the
   * configured vector threshold post-filter (reference VectorRetrieve);
   * explicit semantic mode keeps its historical unthresholded behavior.
   */
  private async retrieveSemantic(
    actor: RagActor,
    trimmedQuery: string,
    query: RagRetrieverQuery,
    profileHash: string,
    pool: number | null,
    limit: number,
  ): Promise<RagEvidence[]> {
    let vectorThreshold: number | null = null;
    if (pool !== null) {
      const stored = (await this.readWorkspaceSettings(
        actor.workspaceId,
        'retrievalSettings',
      )) as Record<string, unknown>;
      const settings = parseRetrievalSettings({
        ...stored,
        ...(query.overrides ?? {}),
      });
      vectorThreshold = settings.vectorThreshold;
    }

    let profile: IndexProfile;
    try {
      profile = await this.profileResolver.resolve(actor.workspaceId);
    } catch (error) {
      if (
        error instanceof RagError &&
        error.code === 'EMBEDDING_NOT_CONFIGURED'
      ) {
        return [];
      }
      throw error;
    }
    if (profile.profileHash !== profileHash) {
      // The profile changed between the persisted pointer and the query;
      // mismatched retrieval is invalidated immediately.
      return [];
    }

    let embedded;
    try {
      embedded = await this.embeddingPort.embedQuery(
        actor.workspaceId,
        profile,
        trimmedQuery,
      );
    } catch (error) {
      // No configured embedding model means the vector channel is
      // unavailable, not a failed retrieval (keyword routes still serve).
      if (
        error instanceof RagError &&
        error.code === 'EMBEDDING_NOT_CONFIGURED'
      ) {
        return [];
      }
      throw error;
    }
    if (embedded.profileHash !== profileHash) {
      return [];
    }

    const candidates = await this.loadCandidates(actor, query, profileHash);
    const visible = await this.filterAuthorized(actor, candidates);

    const evidence: RagEvidence[] = [];
    for (const candidate of visible) {
      // Depending on the driver, jsonb vectors arrive either parsed or as
      // their serialized text form; accept both.
      let values = candidate.embedding as number[] | string | null;
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values) as number[];
        } catch {
          continue;
        }
      }
      if (!Array.isArray(values) || values.length !== embedded.values.length) {
        continue;
      }
      const similarity = cosineSimilarity(embedded.values, values);
      if (similarity === null) {
        continue;
      }
      if (vectorThreshold !== null && similarity < vectorThreshold) {
        continue;
      }
      evidence.push(this.toEvidence(candidate, 'cosine', similarity));
    }
    evidence.sort((left, right) => right.score.value - left.score.value);
    return pool === null ? evidence.slice(0, limit) : evidence.slice(0, pool);
  }

  /**
   * Keyword recall with app-side BM25 scoring: the functional replacement for
   * the pinned reference's ParadeDB `content ||| query` recall ordered by
   * `paradedb.score(id)` (stock deployments run postgres:18 without ParadeDB).
   * Recall matches any query lexeme (exact-token match-any, per the
   * reference) using tsvector, orders the recall window by ts_rank as a
   * heuristic, and scores the recalled window with BM25 over corpus
   * statistics of the eligible corpus.
   *
   * The exposed keywordThreshold is NOT applied here, matching the reference
   * PostgreSQL implementation which does not apply it either (documented
   * limitation of the reference retriever).
   */
  private async retrieveKeyword(
    actor: RagActor,
    trimmedQuery: string,
    query: RagRetrieverQuery,
    profileHash: string,
    pool: number,
    limit: number,
  ): Promise<RagEvidence[]> {
    const terms = await this.queryLexemes(trimmedQuery);
    if (terms.length === 0) {
      return [];
    }

    // Corpus statistics first: the recall cap below orders by exact BM25, so
    // it needs the same idf/avgdl inputs the final scorer uses.
    const stats = await this.loadBm25CorpusStats(
      actor,
      query,
      profileHash,
      terms,
    );
    const candidates = await this.loadKeywordCandidates(
      actor,
      query,
      profileHash,
      terms,
      pool,
      stats,
    );
    const visible = await this.filterAuthorized(actor, candidates);
    if (visible.length === 0) {
      return [];
    }

    const evidence = visible.map((candidate) => {
      const document = parseTsvectorText(candidate.tsvectorText);
      const value = bm25Score(document, terms, stats);
      return this.toEvidence(candidate, 'keyword', value);
    });
    evidence.sort((left, right) => right.score.value - left.score.value);
    return evidence.slice(0, limit);
  }

  /**
   * Query lexemes through the same english configuration and unaccent
   * treatment the tsquery match uses.
   */
  private async queryLexemes(query: string): Promise<string[]> {
    const compiled =
      sql`select coalesce(array_agg(distinct t.lexeme) filter (where t.lexeme is not null), '{}') as lexemes from unnest(to_tsvector('english', f_unaccent(${query}))) as t(lexeme, positions, weights)`.compile(
        this.db,
      );
    const result = await this.db.executeQuery(compiled);
    const row = result.rows[0] as { lexemes: string[] | null } | undefined;
    return row?.lexemes ?? [];
  }

  private tsqueryLiteralFor(terms: string[]): string {
    return terms.map((term) => `'${term.replace(/'/g, "''")}'`).join(' | ');
  }

  private async loadKeywordCandidates(
    actor: RagActor,
    query: RagRetrieverQuery,
    profileHash: string,
    terms: string[],
    pool: number,
    stats: Bm25CorpusStats,
  ): Promise<KeywordCandidateRow[]> {
    const matchAny = this.tsqueryLiteralFor(terms);
    const rows = (await this.eligibleChunks(actor, query, profileHash)
      .where(
        sql`to_tsvector('english', rc.text)`,
        '@@',
        sql`to_tsquery('english', ${matchAny})`,
      )
      .select([
        'rc.id as chunkId',
        'rc.workspaceId',
        'rc.pageId',
        'p.spaceId',
        'rc.text',
        'rc.locator',
        'rc.embedding',
        'rg.inputRevision as generationInputRevision',
        sql<string>`to_tsvector('english', rc.text)::text`.as('tsvectorText'),
      ])
      // Exact BM25 ordering over the complete eligible matching set BEFORE
      // the recall cap: a low-rank heuristic can no longer exclude the
      // actual BM25 best candidates (mirrors bm25Score; see bm25SqlExpression).
      .orderBy(sql`${this.bm25SqlExpression(terms, stats)} desc`)
      .limit(pool)
      .execute()) as unknown as KeywordCandidateRow[];
    return rows;
  }

  /**
   * The bm25Score formula (Okapi BM25 with ParadeDB/Lucene idf) expressed as
   * SQL so the recall cap orders the whole eligible matching set by BM25
   * before limiting. Per-row: term frequencies and document length come from
   * the tsvector positions; idf per query lexeme comes from the same corpus
   * statistics the app-side scorer uses (passed in, not recomputed).
   */
  private bm25SqlExpression(
    terms: string[],
    stats: Bm25CorpusStats,
  ): RawBuilder<unknown> {
    const avgdl =
      stats.averageDocumentLength > 0 ? stats.averageDocumentLength : 1;
    const idfRows = terms.map((term) => {
      const df = stats.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (stats.documentCount - df + 0.5) / (df + 0.5));
      return sql`(${term}, ${idf}::float8)`;
    });
    return sql`(
      select coalesce(sum(
        q.idf * (t.tf * ${BM25_K1 + 1}::float8) /
        (t.tf + ${BM25_K1}::float8 * (1 - ${BM25_B}::float8 + ${BM25_B}::float8 * (
          select coalesce(sum(coalesce(array_length(p.positions, 1), 0)), 0)
          from unnest(to_tsvector('english', rc.text)) as p(lexeme, positions, weights)
        )::float8 / ${avgdl}::float8))
      ), 0)
      from unnest(to_tsvector('english', rc.text)) as u(lexeme, positions, weights)
      cross join lateral (select coalesce(array_length(u.positions, 1), 0) as tf) as t
      join (values ${sql.join(idfRows, sql`, `)}) as q(term, idf) on q.term = u.lexeme
      where t.tf > 0
    )`;
  }

  /**
   * BM25 corpus statistics over the eligible corpus: document count, average
   * document length (in token positions) and per-term document frequency.
   * This is the app-side stand-in for ParadeDB's maintained index statistics;
   * it is computed per query, which is correct but not free on large corpora.
   */
  private async loadBm25CorpusStats(
    actor: RagActor,
    query: RagRetrieverQuery,
    profileHash: string,
    terms: string[],
  ): Promise<Bm25CorpusStats> {
    const selections: unknown[] = [
      sql<number>`count(*)::float8`.as('documentCount'),
      sql<number>`coalesce(avg((SELECT coalesce(sum(coalesce(array_length(t.positions, 1), 0)), 0) FROM unnest(to_tsvector('english', rc.text)) AS t(lexeme, positions, weights))), 0)::float8`.as(
        'averageDocumentLength',
      ),
      ...terms.map((term, index) =>
        sql<number>`count(*) filter (where to_tsvector('english', rc.text) @@ to_tsquery('english', ${`'${term.replace(/'/g, "''")}'`}))::float8`.as(
          `df${index}`,
        ),
      ),
    ];
    const row = (await this.eligibleChunks(actor, query, profileHash)
      .select(selections as never)
      .executeTakeFirst()) as unknown as
      | ({ documentCount: number; averageDocumentLength: number } & Record<
          `df${number}`,
          number
        >)
      | undefined;
    if (!row) {
      return {
        documentCount: 0,
        averageDocumentLength: 0,
        documentFrequency: new Map(),
      };
    }
    const documentFrequency = new Map<string, number>();
    terms.forEach((term, index) => {
      documentFrequency.set(term, row[`df${index}`] ?? 0);
    });
    return {
      documentCount: row.documentCount ?? 0,
      averageDocumentLength: row.averageDocumentLength ?? 0,
      documentFrequency,
    };
  }

  /**
   * Candidate chunks come only from the generation the publication pointer
   * names while that pointer still equals the desired revision and the
   * current profile hash. A foreign workspace scope can never match because
   * both the chunk and the page row are constrained to the actor workspace.
   */
  private eligibleChunks(
    actor: RagActor,
    query: RagRetrieverQuery,
    profileHash: string,
  ) {
    return (
      this.db
        .selectFrom('ragChunks as rc')
        .innerJoin('ragSourceState as rss', (join) =>
          join.on((eb) =>
            eb.and([
              eb('rss.workspaceId', '=', eb.ref('rc.workspaceId')),
              eb('rss.pageId', '=', eb.ref('rc.pageId')),
            ]),
          ),
        )
        .innerJoin('ragGenerations as rg', (join) =>
          join.onRef('rg.id', '=', 'rss.publishedGenerationId'),
        )
        .innerJoin('pages as p', 'p.id', 'rc.pageId')
        .where('rc.workspaceId', '=', actor.workspaceId)
        .where('p.workspaceId', '=', actor.workspaceId)
        .where('rg.status', '=', 'published')
        .where('rg.profileHash', '=', profileHash)
        .where('rss.sourceStatus', '=', 'live')
        .where('p.deletedAt', 'is', null)
        // Stale revisions are excluded: the published generation must still be
        // the desired one.
        .whereRef('rss.publishedInputRevision', '=', 'rss.desiredInputRevision')
        .$if(Boolean(query.spaceId), (qb) =>
          qb.where('p.spaceId', '=', query.spaceId as string),
        )
        .$if(Boolean(query.pageIds && query.pageIds.length > 0), (qb) =>
          qb.where('rc.pageId', 'in', query.pageIds as string[]),
        )
    );
  }

  private async loadCandidates(
    actor: RagActor,
    query: RagRetrieverQuery,
    profileHash: string,
  ): Promise<CandidateRow[]> {
    const rows = (await this.eligibleChunks(actor, query, profileHash)
      .select([
        'rc.id as chunkId',
        'rc.workspaceId',
        'rc.pageId',
        'p.spaceId',
        'rc.text',
        'rc.locator',
        'rc.embedding',
        'rg.inputRevision as generationInputRevision',
        sql<number>`null::float8`.as('lexicalRank'),
      ])
      .execute()) as unknown as CandidateRow[];
    return rows;
  }

  /**
   * Recheck current authorization before any text leaves the service: the
   * caller must still be a member of each page's space and must still pass
   * the authoritative page-level restriction check.
   */
  private async filterAuthorized<T extends CandidateRow>(
    actor: RagActor,
    candidates: T[],
  ): Promise<T[]> {
    const spaceIds = new Set(
      await this.spaceMemberRepo.getUserSpaceIds(actor.userId),
    );
    const inSpace = candidates.filter((candidate) =>
      spaceIds.has(candidate.spaceId),
    );
    if (inSpace.length === 0) {
      return [];
    }
    const pageIds = [...new Set(inSpace.map((candidate) => candidate.pageId))];
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds,
        userId: actor.userId,
      }),
    );
    return inSpace.filter((candidate) => accessible.has(candidate.pageId));
  }

  private toEvidence(
    candidate: CandidateRow,
    kind: 'cosine' | 'keyword',
    value: number,
  ): RagEvidence {
    return {
      chunkId: candidate.chunkId,
      key: { workspaceId: candidate.workspaceId, pageId: candidate.pageId },
      inputRevision: toInputRevision(candidate.generationInputRevision),
      text: candidate.text,
      locator: candidate.locator as RagEvidence['locator'],
      score: { kind, value },
    };
  }

  private async readStoredIndexProfileConfig(workspaceId: string): Promise<{
    indexingStrategy?: { vectorEnabled: boolean; keywordEnabled: boolean };
  } | null> {
    const stored = (await this.readWorkspaceSettings(
      workspaceId,
      'indexProfileConfig',
    )) as {
      indexingStrategy?: { vectorEnabled: boolean; keywordEnabled: boolean };
    } | null;
    return stored;
  }

  /** Reads one entry from the owner-controlled `rag` workspace settings. */
  private async readWorkspaceSettings(
    workspaceId: string,
    key: 'retrievalSettings' | 'indexProfileConfig',
  ): Promise<unknown> {
    const row = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const rag = (row?.settings as Record<string, unknown> | null)?.['rag'] as
      | Record<string, unknown>
      | undefined;
    return rag?.[key];
  }
}
