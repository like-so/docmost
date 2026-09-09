import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export const AUTH_PROVIDER_TYPES = ['oidc', 'saml', 'ldap'] as const;
export type AuthProviderType = (typeof AUTH_PROVIDER_TYPES)[number];

export class CreateAuthProviderDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsIn(AUTH_PROVIDER_TYPES)
  type: AuthProviderType;

  @IsOptional()
  @IsBoolean()
  allowSignup?: boolean;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['https'] })
  oidcIssuer?: string;

  @IsOptional()
  @IsString()
  oidcClientId?: string;

  @IsOptional()
  @IsString()
  oidcClientSecret?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['https'] })
  samlUrl?: string;

  @IsOptional()
  @IsString()
  samlCertificate?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['ldaps'] })
  ldapUrl?: string;

  @IsOptional()
  @IsString()
  ldapBindDn?: string;

  @IsOptional()
  @IsString()
  ldapBindPassword?: string;

  @IsOptional()
  @IsString()
  ldapBaseDn?: string;

  @IsOptional()
  @IsString()
  ldapUserSearchFilter?: string;

  @IsOptional()
  @IsObject()
  ldapUserAttributes?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  ldapTlsEnabled?: boolean;

  @IsOptional()
  @IsString()
  ldapTlsCaCert?: string;

  @IsOptional()
  @IsBoolean()
  groupSync?: boolean;

  @IsOptional()
  @IsObject()
  settings?: Record<string, string>;
}
