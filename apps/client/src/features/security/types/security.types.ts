export type AuthProviderKind = "oidc" | "saml" | "ldap";

export interface AuthProvider {
  id: string;
  name: string;
  type: AuthProviderKind;
  isEnabled: boolean;
  allowSignup: boolean;
  groupSync?: boolean;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  samlUrl?: string | null;
  samlCertificate?: string | null;
  ldapUrl?: string | null;
  ldapBindDn?: string | null;
  ldapBaseDn?: string | null;
  ldapUserSearchFilter?: string | null;
  ldapTlsEnabled?: boolean | null;
  ldapUserAttributes?: LdapUserAttributes | null;
  settings?: ProviderSettings;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderInput {
  name: string;
  type: AuthProviderKind;
  isEnabled: boolean;
  allowSignup: boolean;
  groupSync: boolean;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  samlUrl?: string;
  samlCertificate?: string;
  ldapUrl?: string;
  ldapBindDn?: string;
  ldapBindPassword?: string;
  ldapBaseDn?: string;
  ldapUserSearchFilter?: string;
  ldapTlsEnabled?: boolean;
  ldapTlsCaCert?: string;
  ldapUserAttributes?: LdapUserAttributes;
  settings?: ProviderSettings;
}

export interface ProviderSettings {
  allowedDomains?: string;
  emailVerifiedAttribute?: string;
  groupClaim?: string;
  groupAttribute?: string;
}

export interface LdapUserAttributes {
  email?: string;
  name?: string;
  emailVerified?: string;
}

export interface ScimToken {
  id: string;
  name: string;
  lastFour: string;
  isEnabled: boolean;
  createdAt: string;
}

export interface NewScimToken extends ScimToken {
  token: string;
}

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
}
