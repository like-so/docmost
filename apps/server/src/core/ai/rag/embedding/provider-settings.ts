import { createHash } from 'node:crypto';
import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { Workspace } from '@docmost/db/types/entity.types';
import { canonicalJson } from './profile-hash';

const PROVIDER_IDENTITY_DOMAIN = 'docmost-rag-v1:providerSettingsIdentity\n';

/**
 * Minimal shared accessor for the existing encrypted workspace AI provider
 * settings (settings.ai.providerSecret). Callers receive the decrypted
 * provider configuration; credential values must never be logged, persisted
 * or included in error messages.
 */
export interface WorkspaceAiProvider {
  driver: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel?: string;
  rerankModel?: string;
  apiKey?: string;
}

export function readWorkspaceAiProvider(
  workspace: Workspace | null | undefined,
  encryption: EncryptionService,
): WorkspaceAiProvider | undefined {
  const settings = workspace?.settings as {
    ai?: { providerSecret?: string };
  } | null;
  const secret = settings?.ai?.providerSecret;
  if (!secret) return undefined;

  let provider: unknown;
  try {
    provider = JSON.parse(encryption.decrypt(secret));
  } catch {
    throw new Error('Workspace AI provider settings are unreadable');
  }
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof (provider as WorkspaceAiProvider).driver !== 'string' ||
    typeof (provider as WorkspaceAiProvider).baseUrl !== 'string'
  ) {
    throw new Error('Workspace AI provider settings are unreadable');
  }
  return provider as WorkspaceAiProvider;
}

/**
 * The workspace-authorized default rerank model: the owner-configured
 * reference on the existing encrypted AI provider settings. A blank or
 * missing reference means no default is available; callers resolve that to
 * not_configured rather than guessing a model name.
 */
export function workspaceDefaultRerankModel(
  provider: WorkspaceAiProvider | undefined,
): string | null {
  const model = provider?.rerankModel;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

/**
 * Nonsecret identity of the effective encrypted provider settings (contract
 * embedding.endpointIdentity). Covers the fields that define the embedding
 * endpoint and space; credential values are never part of the identity or
 * any diagnostic.
 */
export function providerSettingsIdentity(
  provider: WorkspaceAiProvider,
): string {
  return createHash('sha256')
    .update(PROVIDER_IDENTITY_DOMAIN)
    .update(
      canonicalJson({
        driver: provider.driver,
        baseUrl: provider.baseUrl,
        chatModel: provider.chatModel,
        embeddingModel: provider.embeddingModel ?? null,
      }),
    )
    .digest('hex');
}
