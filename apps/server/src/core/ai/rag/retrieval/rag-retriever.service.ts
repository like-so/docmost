import { Inject, Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import {
  EmbeddingPort,
  IndexProfile,
  RagActor,
  RagEvidence,
  RagError,
  RagProfileResolver,
  RagRetriever,
  RagRetrieverQuery,
  RagRetrieveResult,
  RAG_EMBEDDING_PORT,
  RAG_PROFILE_RESOLVER,
  toInputRevision,
} from '../contracts';
import { RagStateRepository } from '../persistence/rag-state.repository';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

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

/**
 * Authorized evidence boundary (docmost-rag-v1 contract 12). Only chunks from
 * the published generation pointer that still matches the current desired
 * revision, current workspace profile and a live, nondeleted source are
 * eligible; current Docmost authorization (space membership plus page-level
 * restrictions) is rechecked before any text is returned.
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
  ) {}

  async retrieve(
    actor: RagActor,
    query: RagRetrieverQuery,
  ): Promise<RagRetrieveResult> {
    const trimmedQuery = query.query.trim();
    if (trimmedQuery.length < 1) {
      return { evidence: [] };
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
      return { evidence: [] };
    }

    const candidates = await this.loadCandidates(
      actor,
      query,
      profileRow.profileHash,
    );
    const visible = await this.filterAuthorized(actor, candidates);
    if (visible.length === 0) {
      return { evidence: [] };
    }

    let scored: RagEvidence[];
    if (query.mode === 'semantic') {
      scored = await this.rankSemantic(
        actor,
        trimmedQuery,
        visible,
        profileRow.profileHash,
      );
    } else {
      scored = visible.map((candidate) =>
        this.toEvidence(candidate, 'lexical', candidate.lexicalRank ?? 0),
      );
    }

    scored.sort((left, right) => right.score.value - left.score.value);
    return { evidence: scored.slice(0, limit) };
  }

  /**
   * Candidate chunks come only from the generation the publication pointer
   * names while that pointer still equals the desired revision and the
   * current profile hash. A foreign workspace scope can never match because
   * both the chunk and the page row are constrained to the actor workspace.
   */
  private async loadCandidates(
    actor: RagActor,
    query: RagRetrieverQuery,
    profileHash: string,
  ): Promise<CandidateRow[]> {
    const lexical =
      query.mode === 'keyword' ? tsquery(query.query.trim() + '*') : null;

    let qb = this.db
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
      .select([
        'rc.id as chunkId',
        'rc.workspaceId',
        'rc.pageId',
        'p.spaceId',
        'rc.text',
        'rc.locator',
        'rc.embedding',
        'rg.inputRevision as generationInputRevision',
      ]);

    if (query.spaceId) {
      qb = qb.where('p.spaceId', '=', query.spaceId);
    }
    if (query.pageIds && query.pageIds.length > 0) {
      qb = qb.where('rc.pageId', 'in', query.pageIds);
    }
    if (lexical !== null) {
      qb = qb
        .where(
          sql`to_tsvector('english', rc.text)`,
          '@@',
          sql`to_tsquery('english', f_unaccent(${lexical}))`,
        )
        .select(
          sql<number>`ts_rank(to_tsvector('english', rc.text), to_tsquery('english', f_unaccent(${lexical})))`.as(
            'lexicalRank',
          ),
        );
    } else {
      qb = qb.select(sql<number>`null::float8`.as('lexicalRank'));
    }

    return (await qb.execute()) as CandidateRow[];
  }

  /**
   * Recheck current authorization before any text leaves the service: the
   * caller must still be a member of each page's space and must still pass
   * the authoritative page-level restriction check.
   */
  private async filterAuthorized(
    actor: RagActor,
    candidates: CandidateRow[],
  ): Promise<CandidateRow[]> {
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

  /**
   * Semantic mode embeds the query through the real EmbeddingPort and ranks
   * by cosine similarity against the stored chunk vectors. It is never a
   * rerank of lexical hits: candidates without a usable vector are dropped.
   */
  private async rankSemantic(
    actor: RagActor,
    query: string,
    candidates: CandidateRow[],
    profileHash: string,
  ): Promise<RagEvidence[]> {
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

    const embedded = await this.embeddingPort.embedQuery(
      actor.workspaceId,
      profile,
      query,
    );
    if (embedded.profileHash !== profileHash) {
      return [];
    }

    const evidence: RagEvidence[] = [];
    for (const candidate of candidates) {
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
      evidence.push(this.toEvidence(candidate, 'cosine', similarity));
    }
    return evidence;
  }

  private toEvidence(
    candidate: CandidateRow,
    kind: 'cosine' | 'lexical',
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
}

/** Returns null when either vector is degenerate (zero norm or nonfinite). */
export function cosineSimilarity(
  left: number[],
  right: number[],
): number | null {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      return null;
    }
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
