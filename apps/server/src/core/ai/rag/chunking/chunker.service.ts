import { Injectable } from '@nestjs/common';
import {
  Chunk,
  ChunkBatch,
  Chunker,
  ChunkLocator,
  IndexProfile,
  NormalizedDocument,
} from '../contracts';
import { sha256Hex } from '../parsing/document-parser.service';
import { resolveTokenizer } from './tokenizer';

interface CharRange {
  start: number;
  end: number;
}

type TokenCounter = (text: string) => number;

@Injectable()
export class RagChunker implements Chunker {
  async split(
    document: NormalizedDocument,
    profile: IndexProfile,
  ): Promise<ChunkBatch> {
    validateChunkProfile(profile);
    const tokenizer = await resolveTokenizer(
      profile.embedding.tokenizerId,
      profile.embedding.model,
    );
    validateChunkBudget(profile, tokenizer.inputOverheadTokens);
    // The model framing counts against maxChunkTokens, so the split budget
    // for source text is what remains after the framing overhead.
    const sourceBudget = profile.maxChunkTokens - tokenizer.inputOverheadTokens;
    // Source text is counted as ordinary text: special-token literals in
    // the document are never interpreted as model control tokens.
    const countTokens: TokenCounter = (text) => tokenizer.countTextTokens(text);

    const chunks: Chunk[] = [];
    let ordinal = 0;
    for (const section of document.sections) {
      const ranges = splitSectionRanges(
        section.text,
        countTokens,
        sourceBudget,
        profile.overlapTokens,
      );
      for (const range of ranges) {
        const chunkOrdinal = ordinal++;
        const text = section.text.slice(range.start, range.end);
        const locator: ChunkLocator = {
          pageId: document.key.pageId,
          attachmentId:
            section.source.kind === 'attachment'
              ? section.source.attachmentId
              : null,
          headingPath: section.headingPath,
          blockId: section.blockId ?? null,
          pageNumber: section.pageNumber ?? null,
          start: range.start,
          end: range.end,
          offsetUnit: 'utf16',
          textHash: section.textHash,
        };
        chunks.push({
          chunkId: computeChunkId(
            document,
            profile.profileHash,
            locator,
            text,
            chunkOrdinal,
          ),
          ordinal: chunkOrdinal,
          text,
          // The stored count includes the model framing so it is directly
          // comparable with maxChunkTokens and the model input limit.
          tokenCount: countTokens(text) + tokenizer.inputOverheadTokens,
          locator,
        });
      }
    }

    return {
      key: { ...document.key },
      inputRevision: document.inputRevision,
      profileHash: profile.profileHash,
      chunks,
    };
  }
}

/**
 * Enforces the contract invariants that do not depend on the tokenizer:
 * positive integer budgets and a maxChunkTokens within the verified model
 * input limit. Configuration errors fail explicitly instead of being
 * silently clamped.
 */
function validateChunkProfile(profile: IndexProfile): void {
  const { maxChunkTokens, embedding } = profile;
  if (!Number.isSafeInteger(maxChunkTokens) || maxChunkTokens <= 0) {
    throw new Error('RAG chunker: maxChunkTokens must be a positive integer');
  }
  if (
    !Number.isSafeInteger(profile.overlapTokens) ||
    profile.overlapTokens < 0
  ) {
    throw new Error(
      'RAG chunker: overlapTokens must be a non-negative integer',
    );
  }
  if (
    !Number.isSafeInteger(embedding.maxInputTokens) ||
    embedding.maxInputTokens <= 0
  ) {
    throw new Error(
      'RAG chunker: embedding.maxInputTokens must be a positive integer',
    );
  }
  if (maxChunkTokens > embedding.maxInputTokens) {
    throw new Error(
      'RAG chunker: maxChunkTokens exceeds the verified model input limit',
    );
  }
}

/**
 * Enforces the framing-aware budget invariants: maxChunkTokens must leave a
 * positive source-text budget after the model framing overhead, and
 * overlapTokens (which counts source-text tokens only) must stay below that
 * effective source budget.
 */
function validateChunkBudget(
  profile: IndexProfile,
  overheadTokens: number,
): void {
  const effectiveBudget = profile.maxChunkTokens - overheadTokens;
  if (effectiveBudget <= 0) {
    throw new Error(
      `RAG chunker: model framing overhead of ${overheadTokens} tokens leaves no source-text budget within maxChunkTokens ${profile.maxChunkTokens}`,
    );
  }
  if (profile.overlapTokens >= effectiveBudget) {
    throw new Error(
      `RAG chunker: overlapTokens must be smaller than the effective source-text budget (maxChunkTokens ${profile.maxChunkTokens} minus ${overheadTokens} framing tokens)`,
    );
  }
}

/**
 * Chunk identity is deterministic from the document revision, source
 * locator, text, profile and the chunk's ordinal within the batch: the same
 * inputs always produce the same id, and identical repeated sections still
 * get distinct primary keys.
 */
function computeChunkId(
  document: NormalizedDocument,
  profileHash: string,
  locator: ChunkLocator,
  text: string,
  chunkOrdinal: number,
): string {
  return sha256Hex(
    [
      document.key.workspaceId,
      document.key.pageId,
      document.inputRevision,
      profileHash,
      String(chunkOrdinal),
      locator.pageId,
      locator.attachmentId ?? '',
      JSON.stringify(locator.headingPath),
      locator.blockId ?? '',
      locator.pageNumber != null ? String(locator.pageNumber) : '',
      String(locator.start),
      String(locator.end),
      locator.textHash,
      sha256Hex(text),
    ].join('\n'),
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * True when index is not the second utf16 unit of a surrogate pair, so
 * slicing at index keeps whole Unicode scalar values. Offsets stay in the
 * approved utf16 coordinate unit.
 */
function isScalarBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return true;
  }
  return !(
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

/** Smallest scalar-boundary end greater than start. */
function smallestScalarEnd(text: string, start: number): number {
  return isScalarBoundary(text, start + 1) ? start + 1 : start + 2;
}

/**
 * Splits a section into half-open utf16 ranges, each within the token
 * budget. Line boundaries are the preferred structural split points; a line
 * longer than the budget is hard-split by binary search on character
 * offsets at Unicode scalar boundaries so chunk text always equals the
 * exact section slice. The final range always reaches the section end: no
 * tail text is lost.
 */
function splitSectionRanges(
  text: string,
  countTokens: TokenCounter,
  sourceBudget: number,
  overlapTokens: number,
): CharRange[] {
  if (text.length === 0) {
    return [];
  }
  if (countTokens(text) <= sourceBudget) {
    return [{ start: 0, end: text.length }];
  }

  // Pieces leave room for the overlap so a carried suffix never pushes the
  // next chunk over the budget.
  const pieceBudget = sourceBudget - overlapTokens;
  const pieces = tokenBoundedPieces(
    text,
    countTokens,
    pieceBudget,
    sourceBudget,
  );
  const ranges: CharRange[] = [];
  let chunkStart = pieces[0].start;
  let packedEnd = chunkStart;

  for (
    let nextPieceIndex = 0;
    nextPieceIndex < pieces.length;
    nextPieceIndex++
  ) {
    const piece = pieces[nextPieceIndex];
    if (packedEnd > chunkStart) {
      // The budget applies to the complete next-chunk slice, not to
      // separately summed piece counts.
      const candidateTokens = countTokens(text.slice(chunkStart, piece.end));
      if (candidateTokens > sourceBudget) {
        ranges.push({ start: chunkStart, end: packedEnd });
        const pieceTokens = countTokens(text.slice(piece.start, piece.end));
        chunkStart = overlapStart(
          text,
          pieces,
          nextPieceIndex,
          packedEnd,
          chunkStart,
          countTokens,
          Math.min(overlapTokens, sourceBudget - pieceTokens),
        );
        if (countTokens(text.slice(chunkStart, piece.end)) > sourceBudget) {
          chunkStart = packedEnd;
        }
      }
    }
    packedEnd = piece.end;
  }
  if (packedEnd > chunkStart) {
    ranges.push({ start: chunkStart, end: packedEnd });
  }
  return ranges;
}

/**
 * Expands line segments into pieces that each fit the given token budget.
 * Pieces are half-open, adjacent and non-overlapping, covering the section
 * text without gaps. A character that does not fit the overlap-adjusted
 * budget is emitted alone when it still fits sourceBudget; when no
 * complete character fits either limit the split fails explicitly instead
 * of emitting over-budget or invalid text.
 */
function tokenBoundedPieces(
  text: string,
  countTokens: TokenCounter,
  pieceBudget: number,
  sourceBudget: number,
): CharRange[] {
  const pieces: CharRange[] = [];
  for (const segment of lineSegments(text)) {
    if (countTokens(text.slice(segment.start, segment.end)) <= pieceBudget) {
      pieces.push(segment);
      continue;
    }
    let start = segment.start;
    while (start < segment.end) {
      let end = largestEndWithinBudget(
        text,
        start,
        segment.end,
        countTokens,
        pieceBudget,
      );
      if (end === -1) {
        end = smallestScalarEnd(text, start);
        const singleTokens = countTokens(text.slice(start, end));
        if (singleTokens > sourceBudget) {
          throw new Error(
            'RAG chunker: a single character exceeds the source-text token ' +
              'budget; lower overlapTokens or raise maxChunkTokens',
          );
        }
      }
      pieces.push({ start, end });
      start = end;
    }
  }
  return pieces;
}

function lineSegments(text: string): CharRange[] {
  const segments: CharRange[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      if (start < text.length) {
        segments.push({ start, end: text.length });
      }
      return segments;
    }
    segments.push({ start, end: newline + 1 });
    start = newline + 1;
  }
}

/**
 * Largest scalar-boundary end <= limit with
 * tokenCount(text.slice(start, end)) <= budget, or -1 when no complete
 * character fits the budget. The binary search skips utf16 positions inside
 * surrogate pairs and never returns an over-budget end.
 */
function largestEndWithinBudget(
  text: string,
  start: number,
  limit: number,
  countTokens: TokenCounter,
  budget: number,
): number {
  let low = start + 1;
  let high = limit;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = isScalarBoundary(text, mid) ? mid : mid - 1;
    if (candidate < low) {
      low = mid + 1;
      continue;
    }
    if (countTokens(text.slice(start, candidate)) <= budget) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

/**
 * Chooses the next chunk start so it overlaps the previous chunk by at most
 * the overlap budget, preferring line-piece boundaries. Falls back to a
 * character binary search at scalar boundaries for the longest suffix whose
 * actual token count fits the budget, and to no overlap when nothing fits,
 * so progress is always guaranteed.
 */
function overlapStart(
  text: string,
  pieces: CharRange[],
  nextPieceIndex: number,
  packedEnd: number,
  currentChunkStart: number,
  countTokens: TokenCounter,
  overlapBudget: number,
): number {
  if (overlapBudget <= 0) {
    return packedEnd;
  }

  let start = packedEnd;
  for (let j = nextPieceIndex - 1; j >= 0; j--) {
    const piece = pieces[j];
    if (piece.end !== start) {
      break;
    }
    if (piece.start < currentChunkStart) {
      break;
    }
    if (countTokens(text.slice(piece.start, packedEnd)) > overlapBudget) {
      break;
    }
    start = piece.start;
  }
  if (
    start > currentChunkStart &&
    start < packedEnd &&
    countTokens(text.slice(start, packedEnd)) <= overlapBudget
  ) {
    return start;
  }

  // Smallest start whose suffix [start, packedEnd) stays within the budget,
  // i.e. the longest fitting overlap.
  let low = currentChunkStart;
  let high = packedEnd - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = isScalarBoundary(text, mid) ? mid : mid - 1;
    if (candidate < low) {
      low = mid + 1;
      continue;
    }
    if (countTokens(text.slice(candidate, packedEnd)) <= overlapBudget) {
      best = candidate;
      high = candidate - 1;
    } else {
      low = candidate + 1;
    }
  }
  if (best > currentChunkStart && best < packedEnd) {
    return best;
  }
  return packedEnd;
}
