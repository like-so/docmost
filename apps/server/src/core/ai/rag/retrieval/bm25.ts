/**
 * App-side BM25 (Okapi) scoring, the functional replacement for the pinned
 * reference's ParadeDB BM25 index (Tencent/WeKnora bccb4b1
 * internal/application/repository/retriever/postgres/repository.go
 * KeywordsRetrieve: `content ||| query` match-any-token recall ordered by
 * `paradedb.score(id)`). Stock docmost deployments run postgres:18 without
 * ParadeDB, so recall uses PostgreSQL tsvector matching and scoring uses this
 * scorer with corpus statistics computed over the eligible corpus.
 *
 * Parameters k1=1.2, b=0.75 are ParadeDB BM25 defaults; the idf form
 * ln(1 + (N - df + 0.5) / (df + 0.5)) matches ParadeDB/Lucene.
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export interface Bm25CorpusStats {
  /** Number of documents in the eligible corpus (N). */
  documentCount: number;
  /** Average document length in tokens (avgdl). */
  averageDocumentLength: number;
  /** Document frequency per query lexeme. */
  documentFrequency: Map<string, number>;
}

export interface Bm25Document {
  /** Term frequency per lexeme present in the document. */
  termFrequency: Map<string, number>;
  /** Document length in tokens. */
  length: number;
}

/**
 * BM25 score of one document against the query terms. Terms absent from the
 * document contribute 0; terms absent from the corpus use the
 * document-frequency zero convention (df = 0) of the idf formula.
 */
export function bm25Score(
  document: Bm25Document,
  terms: string[],
  stats: Bm25CorpusStats,
  k1 = BM25_K1,
  b = BM25_B,
): number {
  if (stats.documentCount <= 0 || terms.length === 0) return 0;
  const avgdl =
    stats.averageDocumentLength > 0 ? stats.averageDocumentLength : 1;
  let score = 0;
  for (const term of terms) {
    const df = stats.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (stats.documentCount - df + 0.5) / (df + 0.5));
    const tf = document.termFrequency.get(term) ?? 0;
    if (tf === 0) continue;
    const denominator = tf + k1 * (1 - b + (b * document.length) / avgdl);
    score += idf * ((tf * (k1 + 1)) / denominator);
  }
  return score;
}

/**
 * Parses a PostgreSQL tsvector text form ("'lexeme':1,4 'other':2B") into
 * per-lexeme term frequencies and total token count. Position entries carry
 * optional weight letters (A/B/C/D) that are stripped.
 */
export function parseTsvectorText(tsvector: string): {
  termFrequency: Map<string, number>;
  length: number;
} {
  const termFrequency = new Map<string, number>();
  let length = 0;
  for (const entry of splitTsvectorEntries(tsvector)) {
    const colon = entry.lastIndexOf("':");
    if (colon < 0) {
      const lexeme = entry.replace(/^'|'$/g, '');
      if (lexeme) {
        termFrequency.set(lexeme, (termFrequency.get(lexeme) ?? 0) + 1);
        length += 1;
      }
      continue;
    }
    const lexeme = entry.slice(0, colon).replace(/^'/, '');
    const positions = entry
      .slice(colon + 2, entry.endsWith("'") ? -1 : undefined)
      .split(',')
      .filter(Boolean);
    if (!lexeme || positions.length === 0) continue;
    termFrequency.set(lexeme, positions.length);
    length += positions.length;
  }
  return { termFrequency, length };
}

function splitTsvectorEntries(tsvector: string): string[] {
  const entries: string[] = [];
  let current = '';
  let insideQuotes = false;
  for (const char of tsvector.trim()) {
    if (char === "'") insideQuotes = !insideQuotes;
    if (char === ' ' && !insideQuotes) {
      if (current) entries.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) entries.push(current);
  return entries;
}
