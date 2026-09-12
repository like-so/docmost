import { AuthProvider } from '@docmost/db/types/entity.types';

export class AuthProviderDto {
  id: string;
  name: string;
  type: string;
  allowSignup: boolean;
  isEnabled: boolean;
  groupSync: boolean;
  settings: unknown;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  samlUrl: string | null;
  samlEntityId: string | null;
  ldapUrl: string | null;
  ldapBindDn: string | null;
  ldapBaseDn: string | null;
  ldapUserSearchFilter: string | null;
  ldapUserAttributes: unknown;
  ldapTlsEnabled: boolean | null;

  static from(provider: AuthProvider): AuthProviderDto {
    const {
      oidcClientSecret,
      samlCertificate,
      ldapBindPassword,
      ldapTlsCaCert,
      ...safe
    } = provider;
    return safe;
  }
}
