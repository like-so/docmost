import { Workspace } from '@docmost/db/types/entity.types';
import { IndexProfile, IndexProfileConfig } from '../contracts';

/**
 * Component-local port for profile resolution/validation (docmost-rag-v1
 * contract 13). The embedding component owns the real implementation: it
 * derives endpointIdentity from the workspace's authoritative encrypted
 * provider settings (never from client input), rejects unsupported
 * driver/config combinations, never guesses dimensions or model token limits,
 * and derives the deterministic profileHash that every ChunkBatch,
 * EmbeddingBatch, staged generation and query must share. Tests bind a
 * fixture adapter. The validator receives the server-loaded workspace plus
 * nonsecret config values only and must never accept or return plaintext
 * credentials.
 */
export const RAG_PROFILE_CONFIG_VALIDATOR = Symbol(
  'RAG_PROFILE_CONFIG_VALIDATOR',
);

export interface RagProfileConfigValidator {
  validate(workspace: Workspace, config: IndexProfileConfig): IndexProfile;
}
