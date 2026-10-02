import {
  ChunkBatch,
  IndexProfile,
  InputRevision,
  NormalizedDocument,
  NormalizedSection,
} from '../contracts';
import { sha256Hex } from '../parsing/document-parser.service';
import { RagChunker } from './chunker.service';
import { resolveEncoding, resolveTokenizer } from './tokenizer';

describe('RagChunker', () => {
  let chunker: RagChunker;

  beforeEach(() => {
    chunker = new RagChunker();
  });

  describe('small sections', () => {
    it('produces one chunk whose locator resolves to the exact slice', async () => {
      const document = makeDocument([
        pageSection(['Intro'], 'p-1', 'A short paragraph about retrieval.'),
      ]);

      const batch = await chunker.split(document, makeProfile());

      expect(batch.chunks).toHaveLength(1);
      const chunk = batch.chunks[0];
      expect(chunk.ordinal).toBe(0);
      const section = document.sections[0];
      expect(section.text.slice(chunk.locator.start, chunk.locator.end)).toBe(
        chunk.text,
      );
      const encoding = resolveEncoding('o200k_base', '');
      expect(chunk.tokenCount).toBe(encoding.encode(chunk.text).length);
      expect(chunk.tokenCount).toBeLessThanOrEqual(
        makeProfile().maxChunkTokens,
      );
      expect(chunk.locator.offsetUnit).toBe('utf16');
      expect(chunk.locator.textHash).toBe(section.textHash);
    });

    it('is deterministic across runs', async () => {
      const document = makeDocument([
        pageSection(['Intro'], 'p-1', 'Deterministic content.'),
        attachmentSection('a-1', 'Attached deterministic content.'),
      ]);

      const first = await chunker.split(document, makeProfile());
      const second = await chunker.split(document, makeProfile());

      expect(second).toEqual(first);
    });

    it('counts literal special-token text as ordinary text', async () => {
      const text = 'Before __END__ after.';
      const document = makeDocument([pageSection([], null, text)]);

      const batch = await chunker.split(document, makeProfile());

      expect(batch.chunks).toHaveLength(1);
      expect(batch.chunks[0].text).toBe(text);
      const encoding = resolveEncoding('o200k_base', '');
      expect(batch.chunks[0].tokenCount).toBe(
        encoding.encode(text, [], []).length,
      );
    });
  });

  describe('oversize sections', () => {
    it('honors the token limit with structural boundaries and overlap', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 40; i++) {
        lines.push(`Line ${i} with several words of body text.`);
      }
      const text = lines.join('\n');
      const document = makeDocument([pageSection(['Doc'], 'p-big', text)]);
      const profile = makeProfile({ maxChunkTokens: 40, overlapTokens: 8 });

      const batch = await chunker.split(document, profile);

      expect(batch.chunks.length).toBeGreaterThan(1);
      const encoding = resolveEncoding('o200k_base', '');
      for (const chunk of batch.chunks) {
        const section = document.sections[0];
        expect(section.text.slice(chunk.locator.start, chunk.locator.end)).toBe(
          chunk.text,
        );
        expect(chunk.tokenCount).toBe(encoding.encode(chunk.text).length);
        expect(chunk.tokenCount).toBeLessThanOrEqual(40);
      }
      // overlap: consecutive chunks share content
      for (let i = 1; i < batch.chunks.length; i++) {
        expect(batch.chunks[i].locator.start).toBeLessThan(
          batch.chunks[i - 1].locator.end,
        );
      }
      // no lost tail text: the last chunk reaches the section end
      const last = batch.chunks[batch.chunks.length - 1];
      expect(last.locator.end).toBe(text.length);
      // ordinals are sequential across the batch
      batch.chunks.forEach((chunk, index) => {
        expect(chunk.ordinal).toBe(index);
      });
    });

    it('keeps the tail when overlap is zero', async () => {
      const text = Array.from(
        { length: 30 },
        (_, i) => `Paragraph ${i} with a handful of words here.`,
      ).join('\n');
      const document = makeDocument([pageSection(['Doc'], 'p-big', text)]);
      const profile = makeProfile({ maxChunkTokens: 30, overlapTokens: 0 });

      const batch = await chunker.split(document, profile);

      expect(batch.chunks.length).toBeGreaterThan(1);
      const last = batch.chunks[batch.chunks.length - 1];
      expect(last.locator.end).toBe(text.length);
      for (let i = 1; i < batch.chunks.length; i++) {
        expect(batch.chunks[i].locator.start).toBe(
          batch.chunks[i - 1].locator.end,
        );
      }
    });

    it('hard-splits a single line longer than the budget without losing text', async () => {
      const longLine = `word `.repeat(200).trim();
      const document = makeDocument([pageSection([], null, longLine)]);
      const profile = makeProfile({ maxChunkTokens: 20, overlapTokens: 4 });

      const batch = await chunker.split(document, profile);

      expect(batch.chunks.length).toBeGreaterThan(1);
      const covered: [number, number][] = batch.chunks.map((chunk) => [
        chunk.locator.start,
        chunk.locator.end,
      ]);
      expect(covered[0][0]).toBe(0);
      expect(covered[covered.length - 1][1]).toBe(longLine.length);
      for (let i = 1; i < covered.length; i++) {
        expect(covered[i][0]).toBeLessThan(covered[i - 1][1]);
      }
    });

    it('splits only at Unicode scalar boundaries in surrogate-heavy text', async () => {
      const text = String.fromCodePoint(0x10348).repeat(4);
      const document = makeDocument([pageSection([], null, text)]);
      const profile = makeProfile({ maxChunkTokens: 4, overlapTokens: 1 });

      const batch = await chunker.split(document, profile);

      expect(batch.chunks.length).toBeGreaterThan(1);
      const section = document.sections[0];
      for (const chunk of batch.chunks) {
        expect(section.text.slice(chunk.locator.start, chunk.locator.end)).toBe(
          chunk.text,
        );
        expect(hasIsolatedSurrogate(chunk.text)).toBe(false);
        expect(chunk.tokenCount).toBeLessThanOrEqual(4);
      }
      expect(batch.chunks[0].locator.start).toBe(0);
      expect(batch.chunks[batch.chunks.length - 1].locator.end).toBe(
        text.length,
      );
    });

    it('fails explicitly when no complete character fits the token limits', async () => {
      const text = String.fromCodePoint(0x2603).repeat(2);
      const document = makeDocument([pageSection([], null, text)]);
      const profile = makeProfile({
        maxChunkTokens: 1,
        overlapTokens: 0,
        embedding: { ...makeProfile().embedding, maxInputTokens: 1 },
      });

      await expect(chunker.split(document, profile)).rejects.toThrow();
    });
  });

  describe('identity and sources', () => {
    it('keeps page and attachment chunks distinguishable', async () => {
      const document = makeDocument([
        pageSection(['Intro'], 'p-1', 'Page body text.'),
        attachmentSection('a-1', 'Attachment body text.'),
      ]);

      const batch = await chunker.split(document, makeProfile());

      expect(batch.chunks).toHaveLength(2);
      const [pageChunk, attachmentChunk] = batch.chunks;
      expect(pageChunk.locator.attachmentId).toBeNull();
      expect(pageChunk.locator.blockId).toBe('p-1');
      expect(attachmentChunk.locator.attachmentId).toBe('a-1');
      expect(attachmentChunk.locator.blockId).toBeNull();
      expect(attachmentChunk.locator.pageId).toBe(document.key.pageId);
    });

    it('derives chunk ids from revision, locator, text and profile hash', async () => {
      const document = makeDocument([pageSection([], null, 'Stable text.')]);

      const base = await chunker.split(document, makeProfile());
      const newRevision = await chunker.split(
        makeDocument([pageSection([], null, 'Stable text.')], '8'),
        makeProfile(),
      );
      const newProfile = await chunker.split(
        document,
        makeProfile({ profileHash: 'profile-hash-2' }),
      );

      expect(newRevision.chunks[0].chunkId).not.toBe(base.chunks[0].chunkId);
      expect(newProfile.chunks[0].chunkId).not.toBe(base.chunks[0].chunkId);
      expect(newProfile.profileHash).toBe('profile-hash-2');
      expect(base.inputRevision).toBe('7');
    });

    it('gives identical repeated sections distinct chunk ids', async () => {
      const document = makeDocument([
        pageSection(['Notes'], null, 'Repeated section text.'),
        pageSection(['Notes'], null, 'Repeated section text.'),
      ]);

      const batch = await chunker.split(document, makeProfile());

      expect(batch.chunks).toHaveLength(2);
      expect(batch.chunks[0].chunkId).not.toBe(batch.chunks[1].chunkId);
    });

    it('returns an empty batch for a document without sections', async () => {
      const batch = await chunker.split(makeDocument([]), makeProfile());
      expect(batch.chunks).toEqual([]);
      expect(batch.profileHash).toBe(makeProfile().profileHash);
    });
  });

  describe('profile validation', () => {
    it.each([
      ['overlap >= max', { maxChunkTokens: 10, overlapTokens: 10 }],
      [
        'max exceeds model input limit',
        { maxChunkTokens: 200000, overlapTokens: 8 },
      ],
      ['zero max', { maxChunkTokens: 0, overlapTokens: 0 }],
      ['negative overlap', { maxChunkTokens: 10, overlapTokens: -1 }],
    ])('rejects %s', async (_name, overrides) => {
      const profile = makeProfile(overrides);
      await expect(
        chunker.split(makeDocument([pageSection([], null, 'text.')]), profile),
      ).rejects.toThrow();
    });

    it('rejects an unknown tokenizerId explicitly', async () => {
      const profile = makeProfile({
        embedding: {
          driver: 'openai-compatible',
          endpointIdentity: 'default',
          model: 'gpt-4o-mini',
          dimensions: 1536,
          tokenizerId: 'not-a-real-tokenizer',
          maxInputTokens: 128000,
        },
      });

      await expect(
        chunker.split(makeDocument([pageSection([], null, 'text.')]), profile),
      ).rejects.toThrow(/unsupported tokenizerId/);
    });

    it('rejects an unresolvable model without tokenizerId explicitly', async () => {
      const profile = makeProfile({
        embedding: {
          driver: 'openai-compatible',
          endpointIdentity: 'default',
          model: 'totally-unknown-model',
          dimensions: 1536,
          tokenizerId: null,
          maxInputTokens: 128000,
        },
      });

      await expect(
        chunker.split(makeDocument([pageSection([], null, 'text.')]), profile),
      ).rejects.toThrow(/tokenizer/);
    });
  });
  describe('model framing', () => {
    // The registered pinned tokenizer is loaded over the network from its
    // immutable revision; expected counts were verified against the parent
    // embedding model's own /tokenize endpoint.
    const PINNED_TOKENIZER_ID =
      'hf:sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42';
    const longTimeout = 60_000;

    it(
      'includes the post-processor framing in chunk tokenCount',
      async () => {
        const text = '안녕하세요 세계. A short paragraph about retrieval.';
        const document = makeDocument([pageSection([], null, text)]);
        const tokenizer = await resolveTokenizer(PINNED_TOKENIZER_ID, '');

        const batch = await chunker.split(document, makeHfProfile());

        expect(batch.chunks).toHaveLength(1);
        const chunk = batch.chunks[0];
        const section = document.sections[0];
        expect(section.text.slice(chunk.locator.start, chunk.locator.end)).toBe(
          chunk.text,
        );
        expect(await tokenizer.countTextTokens(chunk.text)).toBeGreaterThan(0);
        expect(chunk.tokenCount).toBe(
          (await tokenizer.countTextTokens(chunk.text)) +
            tokenizer.inputOverheadTokens,
        );
        expect(chunk.tokenCount).toBeLessThanOrEqual(
          makeHfProfile().maxChunkTokens,
        );
      },
      longTimeout,
    );

    it(
      'splits oversize sections within the framed budget with source-text overlap',
      async () => {
        const lines: string[] = [];
        for (let i = 0; i < 40; i++) {
          lines.push(`문장 ${i} 에는 몇 개의 단어가 들어 있습니다.`);
        }
        const text = lines.join('\n');
        const document = makeDocument([pageSection(['Doc'], 'p-big', text)]);
        const profile = makeHfProfile({
          maxChunkTokens: 32,
          overlapTokens: 8,
        });
        const tokenizer = await resolveTokenizer(PINNED_TOKENIZER_ID, '');
        const effectiveBudget =
          profile.maxChunkTokens - tokenizer.inputOverheadTokens;

        const batch = await chunker.split(document, profile);

        expect(batch.chunks.length).toBeGreaterThan(1);
        const section = document.sections[0];
        for (const chunk of batch.chunks) {
          expect(
            section.text.slice(chunk.locator.start, chunk.locator.end),
          ).toBe(chunk.text);
          // source-text tokens fit the framed budget
          expect(
            await tokenizer.countTextTokens(chunk.text),
          ).toBeLessThanOrEqual(effectiveBudget);
          // stored count includes the framing
          expect(chunk.tokenCount).toBe(
            (await tokenizer.countTextTokens(chunk.text)) + 2,
          );
          expect(chunk.tokenCount).toBeLessThanOrEqual(profile.maxChunkTokens);
          expect(hasIsolatedSurrogate(chunk.text)).toBe(false);
        }
        // overlap: consecutive chunks share source text, bounded by overlapTokens
        for (let i = 1; i < batch.chunks.length; i++) {
          const previous = batch.chunks[i - 1];
          const current = batch.chunks[i];
          expect(current.locator.start).toBeLessThan(previous.locator.end);
          const overlapSlice = previous.text.slice(
            current.locator.start - previous.locator.start,
          );
          if (overlapSlice.length > 0) {
            expect(
              await tokenizer.countTextTokens(overlapSlice),
            ).toBeLessThanOrEqual(profile.overlapTokens);
          }
        }
        const last = batch.chunks[batch.chunks.length - 1];
        expect(last.locator.end).toBe(text.length);
        batch.chunks.forEach((chunk, index) => {
          expect(chunk.ordinal).toBe(index);
        });
      },
      longTimeout,
    );

    it(
      'splits surrogate-heavy text at scalar boundaries under the framed budget',
      async () => {
        const text = String.fromCodePoint(0x1f1ef, 0x1f1f5).repeat(6);
        const document = makeDocument([pageSection([], null, text)]);
        const profile = makeHfProfile({
          maxChunkTokens: 4,
          overlapTokens: 1,
        });

        const batch = await chunker.split(document, profile);

        expect(batch.chunks.length).toBeGreaterThan(1);
        const section = document.sections[0];
        for (const chunk of batch.chunks) {
          expect(
            section.text.slice(chunk.locator.start, chunk.locator.end),
          ).toBe(chunk.text);
          expect(hasIsolatedSurrogate(chunk.text)).toBe(false);
          expect(chunk.tokenCount).toBeLessThanOrEqual(profile.maxChunkTokens);
        }
        expect(batch.chunks[0].locator.start).toBe(0);
        expect(batch.chunks[batch.chunks.length - 1].locator.end).toBe(
          text.length,
        );
      },
      longTimeout,
    );

    it(
      'rejects a profile whose framing overhead consumes the whole budget',
      async () => {
        const document = makeDocument([pageSection([], null, 'text.')]);
        const profile = makeHfProfile({ maxChunkTokens: 2, overlapTokens: 0 });

        await expect(chunker.split(document, profile)).rejects.toThrow(
          /framing overhead/,
        );
      },
      longTimeout,
    );

    it(
      'rejects overlap that reaches the effective source-text budget',
      async () => {
        const document = makeDocument([pageSection([], null, 'text.')]);
        const profile = makeHfProfile({
          maxChunkTokens: 10,
          overlapTokens: 9,
        });

        await expect(chunker.split(document, profile)).rejects.toThrow(
          /effective source-text budget/,
        );
      },
      longTimeout,
    );
  });
});

function makeHfProfile(overrides?: Partial<IndexProfile>): IndexProfile {
  return makeProfile({
    maxChunkTokens: 128,
    overlapTokens: 16,
    embedding: {
      driver: 'openai-compatible',
      endpointIdentity: 'default',
      model: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      dimensions: 384,
      tokenizerId:
        'hf:sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42',
      maxInputTokens: 128,
    },
    ...overrides,
  });
}

function makeProfile(overrides?: Partial<IndexProfile>): IndexProfile {
  return {
    profileId: '11111111-1111-4111-8111-111111111111',
    profileHash: 'profile-hash-1',
    parserVersion: '1',
    chunkerVersion: '1',
    maxChunkTokens: 512,
    overlapTokens: 64,
    sourcePolicy: {
      requiredMimeTypes: ['text/plain'],
      imageInterpretation: 'disabled',
    },
    embedding: {
      driver: 'openai-compatible',
      endpointIdentity: 'default',
      model: 'gpt-4o-mini',
      dimensions: 1536,
      tokenizerId: 'o200k_base',
      maxInputTokens: 128000,
    },
    ...overrides,
  } as IndexProfile;
}

function makeDocument(
  sections: NormalizedSection[],
  inputRevision: string = '7',
): NormalizedDocument {
  return {
    key: {
      workspaceId: '22222222-2222-4222-8222-222222222222',
      pageId: '33333333-3333-4333-8333-333333333333',
    },
    inputRevision: inputRevision as InputRevision,
    sections,
    diagnostics: [],
  };
}

function pageSection(
  headingPath: string[],
  blockId: string | null,
  text: string,
): NormalizedSection {
  return {
    source: { kind: 'page' },
    headingPath,
    blockId,
    pageNumber: null,
    text,
    textHash: sha256Test(text),
  };
}

function attachmentSection(
  attachmentId: string,
  text: string,
): NormalizedSection {
  return {
    source: { kind: 'attachment', attachmentId },
    headingPath: [],
    blockId: null,
    pageNumber: null,
    text,
    textHash: sha256Test(text),
  };
}

function sha256Test(text: string): string {
  return sha256Hex(text);
}

function isHighSurrogateCode(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogateCode(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function hasIsolatedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      isHighSurrogateCode(code) &&
      (i + 1 === text.length || !isLowSurrogateCode(text.charCodeAt(i + 1)))
    ) {
      return true;
    }
    if (
      isLowSurrogateCode(code) &&
      (i === 0 || !isHighSurrogateCode(text.charCodeAt(i - 1)))
    ) {
      return true;
    }
  }
  return false;
}
