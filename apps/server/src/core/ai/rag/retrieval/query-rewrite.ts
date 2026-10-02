/**
 * Chat query-understanding helpers, ported from Tencent/WeKnora bccb4b1:
 * - query_understand.go: the rewrite model must return a single JSON object
 *   {"rewrite_query","intent","image_description"}; any failure (unparseable
 *   output, missing rewrite_query, model error) falls back to the original
 *   query.
 * - query_expansion.go expandQueries: local, non-LLM query variants to
 *   improve keyword recall, limited to 5.
 *
 * Docmost has no Jieba dictionary, so continuous Han runs are kept whole by
 * the local tokenizer instead of dictionary segmentation; the English-token
 * and rule-based variant paths are otherwise identical to the reference.
 */

export interface RewriteOutput {
  rewriteQuery: string;
  intent: string | null;
  imageDescription: string | null;
}

/**
 * Salvages the pinned rewrite output schema from a model response. Returns
 * null on any failure so the caller falls back to the original query. The
 * intent and image_description fields are parsed but unused: docmost's chat
 * flow has no intent router or image pipeline.
 */
export function parseRewriteOutput(
  content: string | null | undefined,
): RewriteOutput | null {
  if (!content) return null;
  const json = extractJsonBlock(content);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.rewrite_query !== 'string') return null;
  const rewriteQuery = record.rewrite_query.trim();
  if (!rewriteQuery) return null;
  return {
    rewriteQuery,
    intent: typeof record.intent === 'string' ? record.intent : null,
    imageDescription:
      typeof record.image_description === 'string'
        ? record.image_description
        : null,
  };
}

function extractJsonBlock(content: string): string | null {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

// query_expansion.go stopwords (Chinese and English).
const STOPWORDS = new Set([
  '的',
  '是',
  '在',
  '了',
  '和',
  '与',
  '或',
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'about',
  'what',
  'how',
  'why',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
]);

// query_expansion.go questionWords: anchored at the query start.
const QUESTION_WORDS =
  /^(什么是|什么|如何|怎么|怎样|为什么|为何|哪个|哪些|谁|何时|何地|请问|请告诉我|帮我|我想知道|我想了解)/;

export const EXPANSION_MAX_VARIANTS = 5;

/**
 * Generates the local expansion variants of a rewritten query, in reference
 * order (keyword-only variant, quoted phrases, delimiter segments, leading
 * question-word removal), deduplicated case-insensitively against the
 * original query and limited to 5.
 */
export function buildExpansionVariants(
  rewrittenQuery: string,
  originalQuery: string,
): string[] {
  const query = rewrittenQuery.trim();
  if (!query) return [];
  const expansions: string[] = [];
  const seen = new Set<string>([query.toLowerCase()]);
  if (originalQuery.trim()) {
    seen.add(originalQuery.trim().toLowerCase());
  }
  const addIfNew = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length < 3) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    expansions.push(trimmed);
  };

  const keywords = extractKeywords(query);
  if (keywords.length >= 2) {
    addIfNew(keywords.join(' '));
  }
  for (const phrase of extractPhrases(query)) {
    addIfNew(phrase);
  }
  for (const segment of splitByDelimiters(query)) {
    if (segment.length > 5) addIfNew(segment);
  }
  const cleaned = removeQuestionWords(query);
  if (cleaned !== query) addIfNew(cleaned);

  return expansions.slice(0, EXPANSION_MAX_VARIANTS);
}

function extractKeywords(text: string): string[] {
  return tokenize(text).filter(
    (word) => !STOPWORDS.has(word.toLowerCase()) && [...word].length > 1,
  );
}

function extractPhrases(text: string): string[] {
  const phrases: string[] = [];
  const pattern = /["'“”「」『』]([^"'“”「」『』]+)["'“”「」『』]/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] && [...match[1]].length > 2) phrases.push(match[1]);
  }
  return phrases;
}

function splitByDelimiters(text: string): string[] {
  return text
    .split(/[,，;；、。！？!?\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function removeQuestionWords(text: string): string {
  return text.replace(QUESTION_WORDS, '').trim();
}

/**
 * Local tokenizer: runs of letters/digits; Han runs stay whole (no Jieba
 * dictionary in docmost, see the module note).
 */
function tokenize(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
}
