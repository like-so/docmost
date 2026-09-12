import { BadRequestException } from '@nestjs/common';
import { AuthProvider } from '@docmost/db/types/entity.types';
import { ValidateInResponseTo } from '@node-saml/node-saml';
import { buildLdapFilter, validateIssuer } from './federation.util';

export function buildSamlOptions(
  provider: AuthProvider,
  entityId: string,
  callbackUrl: string,
  disableRequestedAuthnContext: boolean,
) {
  if (!provider.samlUrl || !provider.samlCertificate || !provider.samlEntityId) {
    throw new BadRequestException('SAML provider configuration is incomplete.');
  }
  const entryPoint = validateIssuer(provider.samlUrl).toString();
  const issuer = validateIssuer(entityId).toString();
  const callback = validateIssuer(callbackUrl).toString();
  return {
    entryPoint,
    callbackUrl: callback,
    issuer,
    audience: issuer,
    idpCert: provider.samlCertificate,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    acceptedClockSkewMs: 0,
    disableRequestedAuthnContext,
  };
}

export function buildLdapOptions(provider: AuthProvider, username: string) {
  if (!provider.ldapUrl || !provider.ldapBaseDn) {
    throw new BadRequestException('LDAP provider configuration is incomplete.');
  }
  const url = new URL(provider.ldapUrl);
  if (url.protocol !== 'ldaps:') {
    throw new BadRequestException('LDAP providers must use LDAPS.');
  }
  return {
    url: url.toString(),
    baseDn: provider.ldapBaseDn,
    filter: buildLdapFilter(
      provider.ldapUserSearchFilter || '(uid={{username}})',
      username,
    ),
    timeout: 10_000,
    connectTimeout: 10_000,
    tlsOptions: {
      ca: provider.ldapTlsCaCert ? [provider.ldapTlsCaCert] : undefined,
    },
  };
}
