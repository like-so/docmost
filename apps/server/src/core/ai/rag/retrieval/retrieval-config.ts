import {
  IndexProfileConfig,
  IndexingStrategy,
  RagChatRetrievalSettings,
  RagRetrievalOverride,
  RagRetrievalSettings,
} from '../contracts';
import {
  DEFAULT_REWRITE_SYSTEM_PROMPT,
  DEFAULT_REWRITE_USER_PROMPT,
} from './rewrite-default-prompt';

/**
 * Pinned hybrid-retrieval constants, ported from Tencent/WeKnora at
 * bccb4b151bae403508da77fbb174efc79dc47c1a. Each constant names the reference
 * file and symbol it matches. These are behavior constants of the port, not
 * owner settings: the owner controls recall/threshold/rerank settings, not the
 * fusion mathematics.
 */

// knowledgebase_search_fusion.go: weighted RRF constants.
export const RRF_K = 60;
export const RRF_VECTOR_WEIGHT = 0.7;
export const RRF_KEYWORD_WEIGHT = 0.3;

// retrieval_config.go GetEffective* fallbacks (defaults when unset).
export const DEFAULT_RECALL_COUNT = 50; // EmbeddingTopK
export const DEFAULT_VECTOR_THRESHOLD = 0.15;
export const DEFAULT_KEYWORD_THRESHOLD = 0.3;
export const DEFAULT_RERANK_TOP_K = 10;
export const DEFAULT_RERANK_THRESHOLD = 0.2;
// retrieval_config.go MaxRequestedResults caps match_count and rerank.top_k.
export const RECALL_COUNT_MAX = 200;
export const RERANK_TOP_K_MAX = 200;
// retrieval_config.go validation ranges.
export const VECTOR_THRESHOLD_MAX = 1;
export const RERANK_THRESHOLD_MIN = -10;
export const RERANK_THRESHOLD_MAX = 10;

// Over-retrieval pool (knowledgebase_search.go): min(max(matchCount*5,50)*numKBs, 500).
export const OVER_RETRIEVAL_FACTOR = 5;
export const OVER_RETRIEVAL_FLOOR = 50;
export const OVER_RETRIEVAL_CAP = 500;

// rerank.go: composite weights and degrade/fallback behavior.
export const RERANK_COMPOSITE_MODEL_WEIGHT = 0.6;
export const RERANK_COMPOSITE_BASE_WEIGHT = 0.3;
export const RERANK_COMPOSITE_SOURCE_WEIGHT = 0.1;
// Docmost evidence is always workspace-internal, so the reference sourceWeight
// is 1.0 for every passage (rerank.go uses 0.95 only for web_search passages,
// which do not exist in docmost).
export const SOURCE_WEIGHT_WORKSPACE = 1;
export const RERANK_FALLBACK_MIN_SCORE = 0.15;
export const RERANK_DEGRADE_FLOOR = 0.3;
export const RERANK_DEGRADE_FACTOR = 0.7;

// mmr.go: MMR lambda over token-set Jaccard similarity.
export const MMR_LAMBDA = 0.7;

// rerank.go DefaultMaxCandidates bounds the rerank pool.
export const RERANK_POOL_FLOOR = 50;
export const RERANK_MAX_CANDIDATES = 200;

// repository.go (postgres) KeywordsRetrieve: ParadeDB BM25 defaults.
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

// query_expansion.go: expansion budget and variant count.
export const EXPANSION_TOP_K_MULTIPLIER = 2; // max(EmbeddingTopK*2, RerankTopK*2)
export const EXPANSION_MAX_VARIANTS = 5;
// query_expansion.go: expansion uses keywordThreshold*0.8. The reference
// PostgreSQL keyword path does NOT apply the exposed keyword threshold
// (documented limitation), so this factor is carried in settings but is
// ineffective on this implementation exactly as in the reference.
export const EXPANSION_THRESHOLD_FACTOR = 0.8;

// query_understand.go: rewrite model call parameters.
export const REWRITE_TEMPERATURE = 0.3;
export const REWRITE_MAX_TOKENS = 150;

/** Effective indexing channels of a profile config; legacy default both on. */
export function effectiveIndexingStrategy(
  config: Pick<IndexProfileConfig, 'indexingStrategy'> | null | undefined,
): Required<IndexingStrategy> {
  const strategy = config?.indexingStrategy;
  return {
    vectorEnabled: strategy?.vectorEnabled ?? true,
    keywordEnabled: strategy?.keywordEnabled ?? true,
  };
}

const clampNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const clampInt = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value;
};

/**
 * Normalizes untrusted stored JSON into RagRetrievalSettings. Invalid or
 * missing fields fall back to the pinned defaults; out-of-range values are
 * clamped into the reference validation ranges rather than rejected so a
 * drifted setting never disables retrieval.
 */
export function parseRetrievalSettings(stored: unknown): RagRetrievalSettings {
  const record = storedRecord(stored);
  const recallCount = clampInt(record.recallCount);
  const vectorThreshold = clampNumber(record.vectorThreshold);
  const keywordThreshold = clampNumber(record.keywordThreshold);
  const rerankTopK = clampInt(record.rerankTopK);
  const rerankThreshold = clampNumber(record.rerankThreshold);
  return {
    recallCount: boundedInt(
      recallCount ?? DEFAULT_RECALL_COUNT,
      1,
      RECALL_COUNT_MAX,
    ),
    vectorThreshold: bounded(
      vectorThreshold ?? DEFAULT_VECTOR_THRESHOLD,
      0,
      VECTOR_THRESHOLD_MAX,
    ),
    keywordThreshold: bounded(
      keywordThreshold ?? DEFAULT_KEYWORD_THRESHOLD,
      0,
      VECTOR_THRESHOLD_MAX,
    ),
    rerankModel:
      typeof record.rerankModel === 'string' && record.rerankModel.trim()
        ? record.rerankModel.trim()
        : null,
    rerankTopK: boundedInt(
      rerankTopK ?? DEFAULT_RERANK_TOP_K,
      1,
      RERANK_TOP_K_MAX,
    ),
    rerankThreshold: bounded(
      rerankThreshold ?? DEFAULT_RERANK_THRESHOLD,
      RERANK_THRESHOLD_MIN,
      RERANK_THRESHOLD_MAX,
    ),
  };
}

/**
 * Normalizes untrusted stored chat settings. Chat carries ALL RetrievalConfig
 * fields (parsed with the same clamping as the search settings) plus the
 * rewrite/expansion extras. Prompt defaults are the pinned default_rewrite
 * template; an owner-supplied blank prompt falls back to it.
 */
export function parseChatRetrievalSettings(
  stored: unknown,
): RagChatRetrievalSettings {
  const record = storedRecord(stored);
  const prompt = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value : fallback;
  return {
    ...parseRetrievalSettings(stored),
    rewriteEnabled: record.rewriteEnabled !== false,
    expansionEnabled: record.expansionEnabled !== false,
    queryUnderstandingModel:
      typeof record.queryUnderstandingModel === 'string' &&
      record.queryUnderstandingModel.trim()
        ? record.queryUnderstandingModel.trim()
        : null,
    rewriteSystemPrompt: prompt(
      record.rewriteSystemPrompt,
      DEFAULT_REWRITE_SYSTEM_PROMPT,
    ),
    rewriteUserPrompt: prompt(
      record.rewriteUserPrompt,
      DEFAULT_REWRITE_USER_PROMPT,
    ),
  };
}

/**
 * Merges per-request overrides over stored settings for a retrieval run.
 * Plain knobs override when present. rerankModel follows the published
 * server-resolution semantics: an omitted override keeps the stored explicit
 * model, while an explicit null (or a blank reference) CLEARS the stored
 * choice so the flow default resolution runs from scratch; null is NOT a
 * disable switch. Only a non-blank explicit reference overrides the stored
 * value; the server resolves every reference against the workspace's own
 * provider configuration before the rerank stage.
 */
export function mergeRetrievalOverride(
  stored: unknown,
  overrides?: RagRetrievalOverride | null,
): RagRetrievalSettings {
  const knob = overrides ?? {};
  return parseRetrievalSettings({
    ...storedRecord(stored),
    ...(knob.recallCount !== undefined
      ? { recallCount: knob.recallCount }
      : {}),
    ...(knob.vectorThreshold !== undefined
      ? { vectorThreshold: knob.vectorThreshold }
      : {}),
    ...(knob.keywordThreshold !== undefined
      ? { keywordThreshold: knob.keywordThreshold }
      : {}),
    ...(knob.rerankModel !== undefined
      ? { rerankModel: knob.rerankModel }
      : {}),
    ...(knob.rerankTopK !== undefined ? { rerankTopK: knob.rerankTopK } : {}),
    ...(knob.rerankThreshold !== undefined
      ? { rerankThreshold: knob.rerankThreshold }
      : {}),
  });
}

function storedRecord(stored: unknown): Record<string, unknown> {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return {};
  }
  return stored as Record<string, unknown>;
}

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function boundedInt(value: number, min: number, max: number): number {
  return Math.trunc(bounded(value, min, max));
}
