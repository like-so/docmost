export type AuthProviderKind = "oidc" | "saml" | "ldap";

export interface ProviderConnectionInfo {
  oidcCallbackUrl: string;
  samlEntityId: string;
  samlAcsUrl: string;
}

export interface PreparedProvider {
  id: string;
  connectionInfo: ProviderConnectionInfo;
}

export interface AuthProvider {
  connectionInfo?: ProviderConnectionInfo;
  id: string;
  name: string;
  type: AuthProviderKind;
  isEnabled: boolean;
  allowSignup: boolean;
  groupSync?: boolean;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  samlUrl?: string | null;
  samlEntityId?: string | null;
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
  preparedId?: string;
  name: string;
  type: AuthProviderKind;
  isEnabled: boolean;
  allowSignup: boolean;
  groupSync: boolean;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  samlUrl?: string;
  samlEntityId?: string;
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
  attemptId: string;
  secret: string;
  otpauthUrl: string;
}

export interface MfaEnrollment {
  backupCodes: string[];
}

export type MfaChallengeKind = "totp" | "backup";
