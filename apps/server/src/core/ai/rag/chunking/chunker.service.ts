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
import { resolveEncoding } from './tokenizer';

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
    const encoding = resolveEncoding(
      profile.embedding.tokenizerId,
      profile.embedding.model,
    );
    const countTokens: TokenCounter = (text) => encoding.encode(text).length;

    const chunks: Chunk[] = [];
    let ordinal = 0;
    for (const section of document.sections) {
      const ranges = splitSectionRanges(
        section.text,
        countTokens,
        profile.maxChunkTokens,
        profile.overlapTokens,
      );
      for (const range of ranges) {
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
          chunkId: computeChunkId(document, profile.profileHash, locator, text),
          ordinal: ordinal++,
          text,
          tokenCount: countTokens(text),
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
 * Enforces the contract invariant 0 <= overlapTokens < maxChunkTokens <=
 * verified model input limit. Configuration errors fail explicitly instead
 * of being silently clamped.
 */
function validateChunkProfile(profile: IndexProfile): void {
  const { maxChunkTokens, overlapTokens, embedding } = profile;
  if (!Number.isSafeInteger(maxChunkTokens) || maxChunkTokens <= 0) {
    throw new Error('RAG chunker: maxChunkTokens must be a positive integer');
  }
  if (!Number.isSafeInteger(overlapTokens) || overlapTokens < 0) {
    throw new Error(
      'RAG chunker: overlapTokens must be a non-negative integer',
    );
  }
  if (overlapTokens >= maxChunkTokens) {
    throw new Error(
      'RAG chunker: overlapTokens must be smaller than maxChunkTokens',
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
 * Chunk identity is deterministic from the document revision, source
 * locator, text and profile: the same inputs always produce the same id.
 */
function computeChunkId(
  document: NormalizedDocument,
  profileHash: string,
  locator: ChunkLocator,
  text: string,
): string {
  return sha256Hex(
    [
      document.key.workspaceId,
      document.key.pageId,
      document.inputRevision,
      profileHash,
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

/**
 * Splits a section into half-open utf16 ranges, each within the token
 * budget. Line boundaries are the preferred structural split points; a line
 * longer than the budget is hard-split by binary search on character
 * offsets so chunk text always equals the exact section slice. The final
 * range always reaches the section end: no tail text is lost.
 */
function splitSectionRanges(
  text: string,
  countTokens: TokenCounter,
  maxChunkTokens: number,
  overlapTokens: number,
): CharRange[] {
  if (text.length === 0) {
    return [];
  }
  if (countTokens(text) <= maxChunkTokens) {
    return [{ start: 0, end: text.length }];
  }

  // Pieces leave room for the overlap so a carried suffix never pushes the
  // next chunk over the budget.
  const pieceBudget = maxChunkTokens - overlapTokens;
  const pieces = tokenBoundedPieces(text, countTokens, pieceBudget);
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
      if (candidateTokens > maxChunkTokens) {
        ranges.push({ start: chunkStart, end: packedEnd });
        const pieceTokens = countTokens(text.slice(piece.start, piece.end));
        chunkStart = overlapStart(
          text,
          pieces,
          nextPieceIndex,
          packedEnd,
          chunkStart,
          countTokens,
          Math.min(overlapTokens, maxChunkTokens - pieceTokens),
        );
        if (countTokens(text.slice(chunkStart, piece.end)) > maxChunkTokens) {
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
 * text without gaps.
 */
function tokenBoundedPieces(
  text: string,
  countTokens: TokenCounter,
  pieceBudget: number,
): CharRange[] {
  const pieces: CharRange[] = [];
  for (const segment of lineSegments(text)) {
    if (countTokens(text.slice(segment.start, segment.end)) <= pieceBudget) {
      pieces.push(segment);
      continue;
    }
    let start = segment.start;
    while (start < segment.end) {
      const end = largestEndWithinBudget(
        text,
        start,
        segment.end,
        countTokens,
        pieceBudget,
      );
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

/** Largest end <= limit with tokenCount(text.slice(start, end)) <= budget. */
function largestEndWithinBudget(
  text: string,
  start: number,
  limit: number,
  countTokens: TokenCounter,
  budget: number,
): number {
  let low = start + 1;
  let high = limit;
  let best = start + 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (countTokens(text.slice(start, mid)) <= budget) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Chooses the next chunk start so it overlaps the previous chunk by at most
 * the overlap budget, preferring line-piece boundaries. Falls back to a
 * character binary search for the longest suffix that fits the budget, and
 * to no overlap when nothing fits, so progress is always guaranteed.
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
  let acc = 0;
  for (let j = nextPieceIndex - 1; j >= 0; j--) {
    const piece = pieces[j];
    if (piece.end !== start) {
      break;
    }
    if (piece.start < currentChunkStart) {
      break;
    }
    const tokens = countTokens(text.slice(piece.start, piece.end));
    if (acc + tokens > overlapBudget) {
      break;
    }
    acc += tokens;
    start = piece.start;
  }
  if (start > currentChunkStart && start < packedEnd) {
    return start;
  }

  // Smallest start whose suffix [start, packedEnd) stays within the budget,
  // i.e. the longest fitting overlap.
  let low = currentChunkStart;
  let high = packedEnd - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (countTokens(text.slice(mid, packedEnd)) <= overlapBudget) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (best > currentChunkStart && best < packedEnd) {
    return best;
  }
  return packedEnd;
}
