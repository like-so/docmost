import { RagEvidence } from '../contracts';
import {
  MMR_LAMBDA,
  RERANK_COMPOSITE_BASE_WEIGHT,
  RERANK_COMPOSITE_MODEL_WEIGHT,
  RERANK_COMPOSITE_SOURCE_WEIGHT,
  RERANK_DEGRADE_FACTOR,
  RERANK_DEGRADE_FLOOR,
  RERANK_FALLBACK_MIN_SCORE,
  RERANK_MAX_CANDIDATES,
  SOURCE_WEIGHT_WORKSPACE,
} from './retrieval-config';

/**
 * Rerank stage, ported from Tencent/WeKnora bccb4b1
 * internal/application/service/rerank/rerank.go (Rerank, applyThreshold,
 * CompositeScore) and internal/application/service/retriever/mmr.go
 * (SelectMMR). Pure functions: the caller performs the model call through
 * RAG_RERANK_PORT and feeds aligned relevance scores back in.
 *
 * Outcomes: model scores unavailable (null) or malformed preserve retrieval
 * order unchanged; threshold filtering degrades once when the threshold sits
 * above the degrade floor; when nothing passes, the top-1 fallback keeps the
 * best candidate if it reaches the fallback minimum score (0 for an
 * explicitly scoped search so a global threshold cannot erase the scope).
 */

export type RerankOutcome =
  | 'ok'
  | 'threshold_degraded'
  | 'fallback_top1'
  | 'all_below_threshold'
  | 'model_unavailable';

export interface RerankStageInput {
  /** Fused candidates in retrieval-score order (best first). */
  candidates: RagEvidence[];
  /** Model relevance scores aligned with candidates; null keeps order. */
  modelScores: number[] | null;
  threshold: number;
  topK: number;
  /** True when the search named an explicit scope (spaceId/pageIds). */
  explicitScope: boolean;
}

export interface RerankStageResult {
  evidence: RagEvidence[];
  outcome: RerankOutcome;
  effectiveThreshold: number;
}

export function applyRerankStage(input: RerankStageInput): RerankStageResult {
  const candidates = input.candidates.slice(0, RERANK_MAX_CANDIDATES);
  if (candidates.length === 0) {
    return {
      evidence: [],
      outcome: 'all_below_threshold',
      effectiveThreshold: input.threshold,
    };
  }
  if (
    input.modelScores === null ||
    input.modelScores.length !== candidates.length
  ) {
    return {
      evidence: candidates,
      outcome: 'model_unavailable',
      effectiveThreshold: input.threshold,
    };
  }

  const scored = candidates.map((candidate, index) => ({
    candidate,
    modelScore: input.modelScores![index],
  }));
  const fallbackMinScore = input.explicitScope ? 0 : RERANK_FALLBACK_MIN_SCORE;
  const { passing, outcome, effectiveThreshold } = applyThreshold(
    scored,
    input.threshold,
    fallbackMinScore,
  );
  if (passing.length === 0) {
    return { evidence: [], outcome, effectiveThreshold };
  }

  passing.sort((left, right) => compositeOf(right) - compositeOf(left));
  const picks = selectMmr(
    passing,
    Math.min(Math.max(1, Math.trunc(input.topK)), passing.length),
    MMR_LAMBDA,
    (entry) => buildModelPassage(entry.candidate),
  );
  return {
    evidence: picks.map((index) => {
      const pick = passing[index];
      return {
        ...pick.candidate,
        score: { kind: 'rerank' as const, value: compositeOf(pick) },
      };
    }),
    outcome,
    effectiveThreshold,
  };
}

interface ScoredCandidate {
  candidate: RagEvidence;
  modelScore: number;
}

function applyThreshold(
  scored: ScoredCandidate[],
  threshold: number,
  fallbackMinScore: number,
): {
  passing: ScoredCandidate[];
  outcome: RerankOutcome;
  effectiveThreshold: number;
} {
  let passing = scored.filter((entry) => entry.modelScore >= threshold);
  if (passing.length > 0) {
    return { passing, outcome: 'ok', effectiveThreshold: threshold };
  }
  let effectiveThreshold = threshold;
  if (threshold > RERANK_DEGRADE_FLOOR) {
    effectiveThreshold = Math.max(
      threshold * RERANK_DEGRADE_FACTOR,
      RERANK_DEGRADE_FLOOR,
    );
    passing = scored.filter((entry) => entry.modelScore >= effectiveThreshold);
    if (passing.length > 0) {
      return { passing, outcome: 'threshold_degraded', effectiveThreshold };
    }
  }
  const top = scored.reduce<ScoredCandidate | null>(
    (best, entry) =>
      best === null || entry.modelScore > best.modelScore ? entry : best,
    null,
  );
  if (top && top.modelScore >= fallbackMinScore) {
    return { passing: [top], outcome: 'fallback_top1', effectiveThreshold };
  }
  return { passing: [], outcome: 'all_below_threshold', effectiveThreshold };
}

/** rerank.go CompositeScore with the workspace-internal sourceWeight of 1.0. */
export function compositeOf(entry: ScoredCandidate): number {
  const composite =
    RERANK_COMPOSITE_MODEL_WEIGHT * entry.modelScore +
    RERANK_COMPOSITE_BASE_WEIGHT * entry.candidate.score.value +
    RERANK_COMPOSITE_SOURCE_WEIGHT * SOURCE_WEIGHT_WORKSPACE;
  return Math.min(Math.max(composite, 0), 1);
}

/**
 * Model passage for a chunk: the heading path as title, then the chunk body
 * (reference ModelPassage: title, then content, then captions; docmost has no
 * captions).
 */
export function buildModelPassage(evidence: RagEvidence): string {
  const title = evidence.locator.headingPath?.join(' > ') ?? '';
  return [title, evidence.text].filter((part) => part.trim()).join('\n');
}

/**
 * mmr.go SelectMMR: incremental MMR over composite score and token-set
 * Jaccard redundancy; ties go to the earlier entry.
 */
export function selectMmr<T>(
  entries: T[],
  k: number,
  lambda = MMR_LAMBDA,
  passageOf: (entry: T) => string = (entry) =>
    entry instanceof Object && 'text' in (entry as object)
      ? String((entry as { text: unknown }).text)
      : '',
): number[] {
  if (k <= 0 || entries.length === 0) return [];
  const tokenSets = entries.map((entry) => tokenizeSimple(passageOf(entry)));
  const remaining = entries.map((_, index) => index);
  const maxRedundancy = new Array<number>(entries.length).fill(0);
  const selected: number[] = [];
  while (selected.length < k && remaining.length > 0) {
    let bestPos = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [pos, index] of remaining.entries()) {
      const mmr =
        lambda * mmrRelevance(entries[index]) -
        (1 - lambda) * maxRedundancy[index];
      if (mmr > bestScore) {
        bestScore = mmr;
        bestPos = pos;
      }
    }
    const chosen = remaining[bestPos];
    selected.push(chosen);
    remaining.splice(bestPos, 1);
    for (const index of remaining) {
      maxRedundancy[index] = Math.max(
        maxRedundancy[index],
        jaccard(tokenSets[index], tokenSets[chosen]),
      );
    }
  }
  return selected;
}

/**
 * MMR relevance input. The reference selects over the composite score; the
 * stage callers map entries to { score } before calling selectMmr, so the
 * default reads a `score` field when present.
 */
function mmrRelevance(entry: unknown): number {
  if (typeof entry === 'object' && entry !== null) {
    if ('score' in entry) {
      const value = (entry as { score: unknown }).score;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    const nested = (entry as { candidate?: { score?: { value?: unknown } } })
      .candidate?.score?.value;
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return 0;
}

/** searchutil.TokenizeSimple equivalent: lowercase letter/digit runs. */
export function tokenizeSimple(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase().normalize('NFKC');
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    tokens.add(match[0]);
  }
  return tokens;
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
