import { AuthProvider } from '@docmost/db/types/entity.types';

type GroupKey = 'groupClaim' | 'groupAttribute';

const OIDC_KEYS = ['groups', 'roles'];
const SAML_KEYS = [
  'groups',
  'Groups',
  'memberOf',
  'memberof',
  'roles',
  'Roles',
  'http://schemas.xmlsoap.org/claims/Group',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/role',
];

export function readProviderGroups(
  provider: Pick<AuthProvider, 'groupSync' | 'settings' | 'type'>,
  claims: Record<string, unknown>,
  setting: GroupKey = 'groupClaim',
): string[] | undefined {
  if (!provider.groupSync) return undefined;
  const keys = configuredKeys(provider, setting);
  const raw = keys
    .map((key) => claims[key])
    .filter((value) => value !== undefined);
  if (
    !raw.length ||
    raw.some((value) => !Array.isArray(value) && typeof value !== 'string')
  ) {
    return undefined;
  }
  const values = raw.flatMap((value) => groupValues(value, provider.type));
  return [...new Set(values)];
}

export function getProviderGroupKey(
  provider: Pick<AuthProvider, 'settings'>,
  setting: GroupKey,
): string | undefined {
  if (!provider.settings || typeof provider.settings !== 'object')
    return undefined;
  const key = (provider.settings as Record<string, unknown>)[setting];
  return typeof key === 'string' && key.trim() ? key.trim() : undefined;
}

function configuredKeys(
  provider: Pick<AuthProvider, 'settings' | 'type'>,
  setting: GroupKey,
): string[] {
  const configured = getProviderGroupKey(provider, setting);
  if (configured) return [configured];
  if (setting === 'groupAttribute') return [];
  if (provider.type === 'oidc') return OIDC_KEYS;
  return provider.type === 'saml' ? SAML_KEYS : [];
}

function groupValues(
  value: unknown,
  providerType: AuthProvider['type'],
): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  return values
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) =>
      providerType === 'ldap' ? [ldapName(item)] : item.split(/[;,]/),
    )
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean);
}

function ldapName(value: string): string {
  return value.match(/^\s*cn\s*=\s*([^,]+)/i)?.[1] ?? value;
}
