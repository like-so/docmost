import {
  allowedDomains,
  isAllowedEmail,
  readLdapIdentity,
  readOidcIdentity,
  readSamlIdentity,
} from './federated-identity';

describe('federated identity mapping', () => {
  it('requires the OIDC email_verified claim before trusting an email', () => {
    expect(
      readOidcIdentity({ sub: 'subject', email: 'person@example.com' }),
    ).toMatchObject({ emailVerified: false });
    expect(
      readOidcIdentity({
        sub: 'subject',
        email: 'person@example.com',
        email_verified: true,
      }),
    ).toMatchObject({ emailVerified: true });
  });

  it('maps documented SAML and configured LDAP attribute aliases', () => {
    expect(
      readSamlIdentity(
        {
          nameID: 'subject',
          mail: 'person@example.com',
          displayName: 'Person',
        },
        { emailVerifiedAttribute: 'email_verified' },
      ),
    ).toMatchObject({
      email: 'person@example.com',
      name: 'Person',
      emailVerified: false,
    });
    expect(
      readSamlIdentity(
        {
          nameID: 'subject',
          mail: 'person@example.com',
          email_verified: 'true',
        },
        { emailVerifiedAttribute: 'email_verified' },
      ),
    ).toMatchObject({ emailVerified: true });
    expect(
      readLdapIdentity(
        'subject',
        { uid: 'person@example.com', cn: 'Person' },
        { email: 'uid', name: 'cn', emailVerified: 'mailVerified' },
      ),
    ).toMatchObject({
      email: 'person@example.com',
      name: 'Person',
      emailVerified: false,
    });
  });

  it('only allows normalized exact configured domains', () => {
    const settings = { allowedDomains: 'Example.com; @internal.example' };
    expect(allowedDomains(settings)).toEqual([
      'example.com',
      'internal.example',
    ]);
    expect(isAllowedEmail('PERSON@EXAMPLE.COM', settings)).toBe(true);
    expect(isAllowedEmail('person@notexample.com', settings)).toBe(false);
    expect(isAllowedEmail('person@child.example.com', settings)).toBe(false);
    expect(isAllowedEmail('person@unrestricted.example', {})).toBe(true);
  });
});
