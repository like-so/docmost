export interface FederatedIdentity {
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  groups?: string[];
}

const EMAIL_KEYS = [
  'email',
  'mail',
  'emailAddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_KEYS = [
  'name',
  'displayName',
  'cn',
  'givenName',
  'urn:oid:2.16.840.1.113730.3.1.241',
];

export function readSamlIdentity(
  profile: Record<string, unknown>,
  settings?: unknown,
): FederatedIdentity {
  const subject = readString(profile.nameID);
  if (!subject) throw new Error('SAML assertion has no subject.');
  return {
    subject,
    email: readAlias(profile, EMAIL_KEYS),
    emailVerified: readVerifiedAttribute(profile, settings),
    name: readAlias(profile, NAME_KEYS),
  };
}

export function readLdapIdentity(
  subject: string,
  entry: Record<string, unknown>,
  attributes: unknown,
): FederatedIdentity {
  const configured = attributes as Record<string, unknown> | null;
  return {
    subject,
    email: readString(entry[readString(configured?.email) ?? 'mail']),
    emailVerified: readVerifiedValue(
      entry[readString(configured?.emailVerified) ?? ''],
    ),
    name: readString(entry[readString(configured?.name) ?? 'displayName']),
  };
}

export function readOidcIdentity(
  claims: Record<string, unknown>,
): FederatedIdentity {
  const subject = readString(claims.sub);
  if (!subject) throw new Error('OIDC response has no subject.');
  return {
    subject,
    email: readString(claims.email),
    emailVerified: claims.email_verified === true,
    name: readString(claims.name),
  };
}

export function allowedDomains(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') return [];
  const values = (settings as Record<string, unknown>).allowedDomains;
  const entries = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(/[;,]/)
      : [];
  return [
    ...new Set(entries.filter(isString).map(normalizeDomain).filter(Boolean)),
  ];
}

export function isAllowedEmail(email: string, settings: unknown): boolean {
  const domain = email.trim().toLowerCase().split('@')[1];
  const allowed = allowedDomains(settings);
  return Boolean(domain && (!allowed.length || allowed.includes(domain)));
}

export function normalizeProviderSettings(
  settings: unknown,
): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return undefined;
  const allowed = allowedDomains(settings);
  const result = { ...(settings as Record<string, unknown>) };
  if (allowed.length) result.allowedDomains = allowed.join(',');
  else delete result.allowedDomains;
  return result;
}

function readAlias(
  values: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readString(values[key]);
    if (value) return value;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readVerifiedAttribute(
  values: Record<string, unknown>,
  settings: unknown,
): boolean {
  const configured =
    settings && typeof settings === 'object'
      ? readString((settings as Record<string, unknown>).emailVerifiedAttribute)
      : undefined;
  return readVerifiedValue(values[configured ?? '']);
}

function readVerifiedValue(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === 'string' && /^(true|1)$/i.test(value.trim()))
  );
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
