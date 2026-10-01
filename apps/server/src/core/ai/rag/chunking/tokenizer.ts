import {
  Tiktoken,
  TiktokenEncoding,
  TiktokenModel,
  encodingForModel,
  getEncoding,
} from 'js-tiktoken';
import { Tokenizer } from '@huggingface/tokenizers';
import { request } from 'undici';

/**
 * Model-matched token counting for a resolved embedding profile. Source text
 * is counted as plain text with no model framing; framing overhead is the
 * number of special tokens the tokenizer post-processor wraps a single
 * sequence in (0 for tiktoken profiles, 2 for the registered pinned Unigram
 * tokenizer).
 */
export interface RagTokenizer {
  countTextTokens(text: string): number;
  inputOverheadTokens: number;
}

const encodingCache = new Map<string, Tiktoken>();

/**
 * Registered pinned tokenizer profiles. tokenizerId is `hf:<repo>@<revision>`;
 * only entries listed here can ever be resolved, so no arbitrary
 * user-supplied URL or revision is ever downloaded. The pinned revision
 * carries a Unigram tokenizer.json with Precompiled normalization and
 * Metaspace decoding whose post-processor wraps input in <s>...</s>.
 */
const REGISTERED_HF_TOKENIZERS: Record<
  string,
  { repo: string; revision: string }
> = {
  'hf:sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42':
    {
      repo: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      revision: 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42',
    },
};

const HF_TOKENIZER_URL_BASE = 'https://huggingface.co';

/** In-flight or loaded pinned tokenizers, keyed by full tokenizerId. */
const hfTokenizerCache = new Map<string, Promise<RagTokenizer>>();

/**
 * Resolves the model-matched tokenizer for a profile. `hf:` ids resolve only
 * through the registered pinned registry; everything else keeps the existing
 * tiktoken behavior with zero added framing.
 */
export async function resolveTokenizer(
  tokenizerId: string | null,
  model: string,
): Promise<RagTokenizer> {
  if (tokenizerId?.startsWith('hf:')) {
    return resolveRegisteredHfTokenizer(tokenizerId);
  }
  const encoding = resolveEncoding(tokenizerId, model);
  return {
    countTextTokens: (text) => encoding.encode(text, [], []).length,
    inputOverheadTokens: 0,
  };
}

/**
 * Resolves the tiktoken encoding for a profile. An explicit tokenizerId is
 * tried as a tiktoken encoding name first, then as a model name. Without a
 * tokenizerId the embedding model name must resolve; nothing is guessed
 * silently.
 */
export function resolveEncoding(
  tokenizerId: string | null,
  model: string,
): Tiktoken {
  const cacheKey = tokenizerId ? `id:${tokenizerId}` : `model:${model}`;
  const cached = encodingCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let encoding: Tiktoken;
  if (tokenizerId) {
    try {
      encoding = getEncoding(tokenizerId as TiktokenEncoding);
    } catch {
      try {
        encoding = encodingForModel(tokenizerId as TiktokenModel);
      } catch {
        throw new Error(
          `RAG chunker: unsupported tokenizerId "${tokenizerId}"`,
        );
      }
    }
  } else {
    try {
      encoding = encodingForModel(model as TiktokenModel);
    } catch {
      throw new Error(
        `RAG chunker: cannot resolve a tokenizer for model "${model}"; set an explicit tokenizerId`,
      );
    }
  }

  encodingCache.set(cacheKey, encoding);
  return encoding;
}

/**
 * Loads a registered pinned tokenizer at most once per tokenizerId and
 * reuses the in-flight or loaded result afterwards. Failed loads are not
 * cached, so a transient fetch failure can be retried without poisoning the
 * cache.
 */
function resolveRegisteredHfTokenizer(
  tokenizerId: string,
): Promise<RagTokenizer> {
  const cached = hfTokenizerCache.get(tokenizerId);
  if (cached) {
    return cached;
  }

  const entry = REGISTERED_HF_TOKENIZERS[tokenizerId];
  if (!entry) {
    return Promise.reject(
      new Error(
        `RAG chunker: tokenizerId "${tokenizerId}" is not a registered pinned tokenizer`,
      ),
    );
  }

  const load = loadRegisteredHfTokenizer(tokenizerId, entry);
  hfTokenizerCache.set(tokenizerId, load);
  load.catch(() => {
    if (hfTokenizerCache.get(tokenizerId) === load) {
      hfTokenizerCache.delete(tokenizerId);
    }
  });
  return load;
}

async function loadRegisteredHfTokenizer(
  tokenizerId: string,
  entry: { repo: string; revision: string },
): Promise<RagTokenizer> {
  // The URL is derived from the registered pinned entry, never from user
  // input, and the revision is immutable so the payload is deterministic.
  let url = `${HF_TOKENIZER_URL_BASE}/${entry.repo}/resolve/${entry.revision}/tokenizer.json`;
  // HuggingFace's /resolve/ endpoint redirects to its content CDN; follow a
  // bounded chain of https redirects explicitly.
  for (let redirect = 0; ; redirect++) {
    const response = await request(url, { method: 'GET' });
    try {
      if (
        (response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 307 ||
          response.statusCode === 308) &&
        redirect < 5
      ) {
        const location = response.headers['location'];
        if (typeof location !== 'string' || !location.startsWith('https://')) {
          throw new Error(
            `RAG chunker: pinned tokenizer fetch for "${tokenizerId}" hit an invalid redirect`,
          );
        }
        url = location;
        continue;
      }
      if (response.statusCode !== 200) {
        throw new Error(
          `RAG chunker: pinned tokenizer fetch for "${tokenizerId}" failed (HTTP ${response.statusCode})`,
        );
      }
      const body = await response.body.text();
      let tokenizerJson: unknown;
      try {
        tokenizerJson = JSON.parse(body);
      } catch {
        throw new Error(
          `RAG chunker: pinned tokenizer payload for "${tokenizerId}" is not valid JSON`,
        );
      }
      if (tokenizerJson === null || typeof tokenizerJson !== 'object') {
        throw new Error(
          `RAG chunker: pinned tokenizer payload for "${tokenizerId}" is not a tokenizer definition`,
        );
      }
      const tokenizer = new Tokenizer(tokenizerJson, {});
      const inputOverheadTokens = derivePostProcessorOverhead(
        tokenizerId,
        tokenizerJson,
        tokenizer,
      );
      return {
        countTextTokens: (text: string) =>
          tokenizer.encode(text, { add_special_tokens: false }).ids.length,
        inputOverheadTokens,
      };
    } finally {
      await response.body.dump();
    }
  }
}

/**
 * Derives the per-sequence framing overhead from the tokenizer
 * post-processor: the number of special tokens its single-sequence template
 * wraps around the content. The derived count must match what encoding an
 * empty string with special tokens actually produces, otherwise the pinned
 * tokenizer is rejected instead of being counted with invented framing.
 */
function derivePostProcessorOverhead(
  tokenizerId: string,
  tokenizerJson: unknown,
  tokenizer: Tokenizer,
): number {
  const postProcessor = (
    tokenizerJson as {
      post_processor?: { type?: unknown; single?: unknown };
    }
  ).post_processor;
  if (
    postProcessor?.type !== 'TemplateProcessing' ||
    !Array.isArray(postProcessor.single)
  ) {
    throw new Error(
      `RAG chunker: pinned tokenizer "${tokenizerId}" has no TemplateProcessing post-processor; framing overhead cannot be derived`,
    );
  }
  const overhead = postProcessor.single.filter(
    (piece) =>
      piece !== null && typeof piece === 'object' && 'SpecialToken' in piece,
  ).length;
  if (!Number.isSafeInteger(overhead) || overhead < 0) {
    throw new Error(
      `RAG chunker: pinned tokenizer "${tokenizerId}" has an invalid post-processor template`,
    );
  }
  const framedEmptyTokens = tokenizer.encode('', {
    add_special_tokens: true,
  }).ids.length;
  if (framedEmptyTokens !== overhead) {
    throw new Error(
      `RAG chunker: pinned tokenizer "${tokenizerId}" framing overhead ${overhead} does not match its actual empty-input framing ${framedEmptyTokens}`,
    );
  }
  return overhead;
}
