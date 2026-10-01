import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { IndexProfileConfig } from '../contracts';

const PROFILE_HASH_DOMAIN = 'docmost-rag-v1:profileHash\n';
const PROFILE_ID_NAMESPACE = '6f1fd667-2d58-4f79-9eb5-8f9d3c0a4b21';

/**
 * Deterministic JSON with recursively sorted object keys so the profile hash
 * covers exactly the configured computation parameters, independent of key
 * order in stored settings.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** profileHash covers ALL nonsecret IndexProfileConfig parameters. */
export function computeProfileHash(config: IndexProfileConfig): string {
  return createHash('sha256')
    .update(PROFILE_HASH_DOMAIN)
    .update(canonicalJson(config))
    .digest('hex');
}

/** The profile identity is pinned to its computation parameters, never secret. */
export function computeProfileId(profileHash: string): string {
  return uuidv5(profileHash, PROFILE_ID_NAMESPACE);
}
