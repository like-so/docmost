import { IndexProfile, IndexProfileConfig } from '../contracts';

/**
 * Component-local port for profile resolution/validation (docmost-rag-v1
 * contract 13). The embedding component owns the real implementation: it
 * resolves endpointIdentity against the existing encrypted provider settings,
 * rejects unsupported driver/config combinations, never guesses dimensions or
 * model token limits, and derives the deterministic profileHash that every
 * ChunkBatch, EmbeddingBatch, staged generation and query must share. Until
 * that component is assembled, tests bind a fixture adapter. The validator
 * receives nonsecret config values only and must never accept or return
 * plaintext credentials.
 */
export const RAG_PROFILE_CONFIG_VALIDATOR = Symbol(
  'RAG_PROFILE_CONFIG_VALIDATOR',
);

export interface RagProfileConfigValidator {
  validate(config: IndexProfileConfig): IndexProfile;
}
