import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export type OidcTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
};

const OIDC_TRANSACTION_TTL = 10 * 60 * 1000;

export function createOidcTransaction(): OidcTransaction {
  return {
    state: randomValue(),
    nonce: randomValue(),
    verifier: randomValue(48),
    createdAt: Date.now(),
  };
}

export function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function validateOidcTransaction(
  transaction: OidcTransaction | undefined,
  state: string | undefined,
  now = Date.now(),
): OidcTransaction {
  if (
    !transaction ||
    !state ||
    now - transaction.createdAt > OIDC_TRANSACTION_TTL
  ) {
    throw new BadRequestException('Invalid or expired OIDC login state.');
  }
  const expected = Buffer.from(transaction.state);
  const received = Buffer.from(state);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new BadRequestException('Invalid or expired OIDC login state.');
  }
  return transaction;
}

export function validateIssuer(issuer: string): URL {
  const parsed = new URL(issuer);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new BadRequestException('OIDC issuer must be an HTTPS URL.');
  }
  return parsed;
}

export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (character) => {
    const codes: Record<string, string> = {
      '\\': '\\5c',
      '*': '\\2a',
      '(': '\\28',
      ')': '\\29',
      '\0': '\\00',
    };
    return codes[character];
  });
}

export function buildLdapFilter(template: string, username: string): string {
  if (!template.includes('{{username}}')) {
    throw new BadRequestException('LDAP filter must contain {{username}}.');
  }
  return template.replaceAll('{{username}}', escapeLdapFilter(username));
}

function randomValue(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
