import { RagEvidence } from '../contracts';
import {
  RRF_K,
  RRF_VECTOR_WEIGHT,
  RRF_KEYWORD_WEIGHT,
} from './retrieval-config';

/**
 * Candidate fusion, ported from Tencent/WeKnora bccb4b1
 * internal/application/service/search/knowledgebase_search_fusion.go
 * (fuseOrDeduplicate) and knowledgebase_search.go (HybridSearch). The three
 * reference branches are preserved exactly:
 * - vector-only: deduplicate by chunk keeping the best cosine, sort desc.
 * - keyword-only: rescale unbounded BM25 by the best score (only when the
 *   maximum exceeds 1), deduplicate, sort desc.
 * - hybrid: weighted RRF over the best rank per chunk per route, normalized
 *   by the total weight (vW + kW) / (k + 1).
 */

export interface FusionCandidate {
  evidence: RagEvidence;
  /** Zero-based dense-recall rank, or null when absent from that route. */
  vectorRank: number | null;
  /** Zero-based keyword-recall rank, or null when absent from that route. */
  keywordRank: number | null;
}

export function fuseVectorOnly(vector: RagEvidence[]): FusionCandidate[] {
  return dedupeByChunk(
    vector.map((evidence, index) => ({
      evidence,
      vectorRank: index,
      keywordRank: null,
    })),
  ).sort(
    (left, right) => right.evidence.score.value - left.evidence.score.value,
  );
}

export function fuseKeywordOnly(keyword: RagEvidence[]): FusionCandidate[] {
  const best = keyword.reduce(
    (max, evidence) => Math.max(max, evidence.score.value),
    0,
  );
  const rescaled =
    best > 1
      ? keyword.map((evidence) => ({
          ...evidence,
          score: {
            kind: 'keyword' as const,
            value: evidence.score.value / best,
          },
        }))
      : keyword;
  return dedupeByChunk(
    rescaled.map((evidence, index) => ({
      evidence,
      vectorRank: null,
      keywordRank: index,
    })),
  ).sort(
    (left, right) => right.evidence.score.value - left.evidence.score.value,
  );
}

export function fuseHybrid(
  vector: RagEvidence[],
  keyword: RagEvidence[],
): FusionCandidate[] {
  const byChunk = new Map<string, FusionCandidate>();
  const register = (
    evidence: RagEvidence,
    route: 'vectorRank' | 'keywordRank',
    index: number,
  ) => {
    const existing = byChunk.get(evidence.chunkId);
    if (!existing) {
      byChunk.set(evidence.chunkId, {
        evidence,
        vectorRank: null,
        keywordRank: null,
        [route]: index,
      });
      return;
    }
    if (existing[route] === null || index < (existing[route] as number)) {
      existing[route] = index;
      // The chunk identity carries the reference's best-rank semantics; the
      // displayed evidence keeps the first-seen route's payload.
      if (route === 'vectorRank') existing.evidence = evidence;
    }
  };
  vector.forEach((evidence, index) => register(evidence, 'vectorRank', index));
  keyword.forEach((evidence, index) =>
    register(evidence, 'keywordRank', index),
  );
  const totalWeight = RRF_VECTOR_WEIGHT + RRF_KEYWORD_WEIGHT;
  const denominator = RRF_K + 1;
  const fused = [...byChunk.values()];
  for (const candidate of fused) {
    const vectorTerm =
      candidate.vectorRank === null
        ? 0
        : RRF_VECTOR_WEIGHT / (RRF_K + candidate.vectorRank + 1);
    const keywordTerm =
      candidate.keywordRank === null
        ? 0
        : RRF_KEYWORD_WEIGHT / (RRF_K + candidate.keywordRank + 1);
    candidate.evidence = {
      ...candidate.evidence,
      score: {
        kind: 'rrf',
        value: (vectorTerm + keywordTerm) / (totalWeight / denominator),
      },
    };
  }
  return fused.sort(
    (left, right) => right.evidence.score.value - left.evidence.score.value,
  );
}

function dedupeByChunk(candidates: FusionCandidate[]): FusionCandidate[] {
  const byChunk = new Map<string, FusionCandidate>();
  for (const candidate of candidates) {
    const existing = byChunk.get(candidate.evidence.chunkId);
    if (
      !existing ||
      candidate.evidence.score.value > existing.evidence.score.value
    ) {
      byChunk.set(candidate.evidence.chunkId, candidate);
    }
  }
  return [...byChunk.values()];
}
