import { BadRequestException } from '@nestjs/common';
import {
  buildLdapFilter,
  createOidcTransaction,
  createPkceChallenge,
  validateIssuer,
  validateOidcTransaction,
} from './federation.util';

describe('federation security utilities', () => {
  it('creates distinct OIDC state, nonce, and PKCE verifier values', () => {
    const transaction = createOidcTransaction();
    expect(transaction.state).not.toBe(transaction.nonce);
    expect(createPkceChallenge(transaction.verifier)).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });

  it('rejects mismatched and expired OIDC state', () => {
    const transaction = createOidcTransaction();
    expect(() => validateOidcTransaction(transaction, 'wrong')).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateOidcTransaction(
        transaction,
        transaction.state,
        transaction.createdAt + 600001,
      ),
    ).toThrow(BadRequestException);
  });

  it('requires HTTPS OIDC issuers', () => {
    expect(() => validateIssuer('http://issuer.example.com')).toThrow(
      BadRequestException,
    );
    expect(validateIssuer('https://issuer.example.com').hostname).toBe(
      'issuer.example.com',
    );
  });

  it('escapes LDAP filter assertion values', () => {
    expect(buildLdapFilter('(uid={{username}})', 'a*)(b\\c')).toBe(
      '(uid=a\\2a\\29\\28b\\5cc)',
    );
    expect(() => buildLdapFilter('(uid={username})', 'person')).toThrow(
      'LDAP filter must contain {{username}}.',
    );
  });
});
