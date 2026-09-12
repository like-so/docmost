import { BadRequestException } from '@nestjs/common';
import { ValidateInResponseTo } from '@node-saml/node-saml';
import { buildLdapOptions, buildSamlOptions } from './federation.config';

describe('federation protocol configurations', () => {
  it('requires signed SAML responses and correlation checks', () => {
    const config = buildSamlOptions(
      {
        samlUrl: 'https://idp.example.com/sso',
        samlEntityId: 'https://idp.example.com/entity',
        samlCertificate: 'certificate',
      } as any,
      'https://docmost.example.com/api/sso/saml/provider/login',
      'https://docmost.example.com/api/sso/saml/provider/callback',
      false,
    );
    expect(config).toMatchObject({
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      validateInResponseTo: ValidateInResponseTo.always,
      idpCert: 'certificate',
      issuer: 'https://docmost.example.com/api/sso/saml/provider/login',
      audience: 'https://docmost.example.com/api/sso/saml/provider/login',
      callbackUrl: 'https://docmost.example.com/api/sso/saml/provider/callback',
      disableRequestedAuthnContext: false,
    });
    expect(() =>
      buildSamlOptions(
        {
          samlUrl: 'https://idp.example.com/sso',
          samlCertificate: 'certificate',
        } as any,
        'https://docmost.example.com/api/sso/saml/provider/login',
        'https://docmost.example.com/api/sso/saml/provider/callback',
        false,
      ),
    ).toThrow(BadRequestException);
  });

  it('requires LDAPS and escaped user filters with bounded timeouts', () => {
    const config = buildLdapOptions(
      {
        ldapUrl: 'ldaps://directory.example.com',
        ldapBaseDn: 'dc=example,dc=com',
        ldapUserSearchFilter: '(uid={{username}})',
      } as any,
      'a*)(b',
    );
    expect(config.filter).toBe('(uid=a\\2a\\29\\28b)');
    expect(config.timeout).toBe(10_000);
    expect(() =>
      buildLdapOptions(
        {
          ldapUrl: 'ldap://directory.example.com',
          ldapBaseDn: 'dc=example',
        } as any,
        'user',
      ),
    ).toThrow(BadRequestException);
  });
});
