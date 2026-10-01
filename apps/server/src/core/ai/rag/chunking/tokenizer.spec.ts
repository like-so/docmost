import { resolveEncoding, resolveTokenizer } from './tokenizer';

// The registered pinned tokenizer is loaded over the network from its
// immutable revision, so these tests exercise the exact artifact the chunker
// uses in production. The expected counts were verified against the parent
// embedding model's own /tokenize endpoint.
const PINNED_TOKENIZER_ID =
  'hf:sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42';

const LONG_TIMEOUT = 60_000;

describe('resolveTokenizer for the registered pinned tokenizer', () => {
  it(
    'derives the framing overhead from the post-processor template',
    async () => {
      const tokenizer = await resolveTokenizer(PINNED_TOKENIZER_ID, '');
      expect(tokenizer.inputOverheadTokens).toBe(2);
    },
    LONG_TIMEOUT,
  );

  it(
    'counts source text without framing and matches the embedding model',
    async () => {
      const tokenizer = await resolveTokenizer(PINNED_TOKENIZER_ID, '');
      expect(tokenizer.countTextTokens('')).toBe(0);
      expect(tokenizer.countTextTokens('hello world')).toBe(3);
      expect(tokenizer.countTextTokens('안녕하세요 세계')).toBe(2);
      expect(tokenizer.countTextTokens('𝄞𝄞')).toBe(2);
      expect(tokenizer.countTextTokens('  spaced   text  ')).toBe(3);
      expect(tokenizer.countTextTokens('Before __END__ after.')).toBe(6);
    },
    LONG_TIMEOUT,
  );

  it(
    'counts literal special-token text as ordinary text',
    async () => {
      const tokenizer = await resolveTokenizer(PINNED_TOKENIZER_ID, '');
      expect(tokenizer.countTextTokens('before <s> after')).toBe(3);
    },
    LONG_TIMEOUT,
  );

  it('rejects an unregistered hf: tokenizerId explicitly', async () => {
    await expect(resolveTokenizer('hf:evil-repo@deadbeef', '')).rejects.toThrow(
      'RAG chunker: tokenizerId "hf:evil-repo@deadbeef" is not a registered pinned tokenizer',
    );
  });

  it('keeps tiktoken profiles at zero framing overhead', () => {
    const tokenizerPromise = resolveTokenizer('o200k_base', '');
    return tokenizerPromise.then((tokenizer) => {
      expect(tokenizer.inputOverheadTokens).toBe(0);
      expect(tokenizer.countTextTokens('hello world')).toBe(2);
      expect(tokenizer.countTextTokens('')).toBe(0);
    });
  });

  it('keeps the tiktoken special-token literal behavior', () => {
    const encoding = resolveEncoding('o200k_base', '');
    expect(encoding.encode('before <s> after', [], []).length).toBe(
      encoding.encode('before <s> after').length,
    );
    expect(encoding.encode('', [], []).length).toBe(0);
  });
});
