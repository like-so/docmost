import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { Workspace } from '@docmost/db/types/entity.types';

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
