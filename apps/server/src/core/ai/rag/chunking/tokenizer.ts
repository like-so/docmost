import {
  Tiktoken,
  TiktokenEncoding,
  TiktokenModel,
  encodingForModel,
  getEncoding,
} from 'js-tiktoken';

const encodingCache = new Map<string, Tiktoken>();

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
