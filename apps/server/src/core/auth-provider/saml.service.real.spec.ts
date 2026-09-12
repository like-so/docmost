import { BadRequestException } from '@nestjs/common';
import { inflateRawSync } from 'node:zlib';
import { SamlService } from './saml.service';
import {
  requestId,
  signedResponse,
  TEST_IDP_CERTIFICATE,
} from '../../../test/fixtures/saml/saml-signed.fixture';

const workspaceId = 'workspace-id';
const providerId = 'provider-id';
const entityId = 'https://docmost.example/api/sso/saml/provider-id/login';
const callbackUrl =
  'https://docmost.example/api/sso/saml/provider-id/callback';
const provider = {
  id: providerId,
  type: 'saml',
  samlUrl: 'https://idp.example.test/sso',
  samlEntityId: 'https://idp.example.test',
  samlCertificate: 'encrypted-certificate',
  groupSync: true,
  settings: { emailVerifiedAttribute: 'email_verified' },
};

describe('SamlService signed response validation', () => {
  let auth: { loginFederated: jest.Mock };
  let disableContext: boolean;
  let redis: ReturnType<typeof redisStore>;
  let service: SamlService;

  beforeEach(() => {
    disableContext = false;
    redis = redisStore();
    auth = { loginFederated: jest.fn().mockResolvedValue({ authToken: 'token' }) };
    service = new SamlService(
      { findEnabled: jest.fn().mockResolvedValue(provider) } as any,
      auth as any,
      {
        getAppSecret: jest.fn().mockReturnValue('test-secret'),
        getSamlDisableRequestedAuthnContext: jest.fn(
          () => disableContext,
        ),
      } as any,
      { decrypt: jest.fn().mockReturnValue(TEST_IDP_CERTIFICATE) } as any,
      { getOrThrow: jest.fn().mockReturnValue(redis) } as any,
    );
  });

  it('validates a doubly signed correlated response and maps identity claims', async () => {
    const transaction = await start(service);
    const response = validResponse(transaction.requestId);

    await expect(callback(service, transaction, response)).resolves.toEqual({
      authToken: 'token',
    });
    expect(auth.loginFederated).toHaveBeenCalledWith(
      providerId,
      expect.objectContaining({
        subject: 'subject-id',
        email: 'person@example.com',
        emailVerified: true,
        name: 'Person',
        groups: ['engineering', 'admins'],
      }),
      workspaceId,
    );
  });

  it('accepts an Assertion issuer when the Response issuer is absent', async () => {
    const transaction = await start(service);

    await expect(
      callback(
        service,
        transaction,
        responseFor(transaction.requestId, { responseIssuer: null }),
      ),
    ).resolves.toEqual({ authToken: 'token' });
  });

  it.each([
    ['Response-only', { assertionIssuer: null }],
    ['Response mismatch', { responseIssuer: 'urn:wrong' }],
    ['Assertion mismatch', { assertionIssuer: 'urn:wrong' }],
    ['duplicate Response issuer', { responseIssuer: ['https://idp.example.test', 'https://idp.example.test'] }],
    ['duplicate Assertion issuer', { assertionIssuer: ['https://idp.example.test', 'https://idp.example.test'] }],
  ])('rejects %s without authenticating', async (_name, options) => {
    const transaction = await start(service);

    await expect(
      callback(service, transaction, responseFor(transaction.requestId, options)),
    ).rejects.toBeInstanceOf(Error);
    expect(auth.loginFederated).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid signature', (id: string) => tamper(validResponse(id))],
    [
      'wrong Assertion issuer',
      (id: string) => responseFor(id, { assertionIssuer: 'urn:wrong' }),
    ],
    [
      'wrong audience',
      (id: string) =>
        responseFor(id, { audience: 'https://other.example/entity' }),
    ],
    [
      'wrong response destination',
      (id: string) =>
        responseFor(id, { destination: 'https://other.example/callback' }),
    ],
    [
      'wrong bearer recipient',
      (id: string) =>
        responseFor(id, { recipient: 'https://other.example/callback' }),
    ],
    [
      'expired conditions',
      (id: string) =>
        responseFor(id, {
          notBefore: new Date(Date.now() - 600_000).toISOString(),
          notOnOrAfter: new Date(Date.now() - 60_000).toISOString(),
        }),
    ],
    [
      'not-yet-valid conditions',
      (id: string) =>
        responseFor(id, {
          notBefore: new Date(Date.now() + 60_000).toISOString(),
          notOnOrAfter: new Date(Date.now() + 600_000).toISOString(),
        }),
    ],
    [
      'mismatched subject correlation',
      (id: string) => responseFor(id, { subjectInResponseTo: 'other-id' }),
    ],
    [
      'mismatched response correlation',
      (id: string) => responseFor(id, { responseInResponseTo: 'other-id' }),
    ],
  ])('rejects a %s response after a fresh start transaction', async (_name, create) => {
    const transaction = await start(service);

    await expect(
      callback(service, transaction, create(transaction.requestId)),
    ).rejects.toBeInstanceOf(Error);
    expect(auth.loginFederated).not.toHaveBeenCalled();
  });

  it('rejects missing response correlation with a fresh start transaction', async () => {
    const transaction = await start(service);

    await expect(
      callback(
        service,
        transaction,
        responseFor(transaction.requestId, { omitResponseInResponseTo: true }),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects a replay after one successful correlated callback', async () => {
    const transaction = await start(service);
    const response = validResponse(transaction.requestId);

    await expect(callback(service, transaction, response)).resolves.toEqual({
      authToken: 'token',
    });
    const replay = await start(service);
    await expect(callback(service, replay, response)).rejects.toBeInstanceOf(Error);
    expect(auth.loginFederated).toHaveBeenCalledTimes(1);
  });

  it('allows one of two fresh bindings to claim a signed response', async () => {
    const original = await start(service);
    const response = validResponse(original.requestId);
    const alternate = await start(service);
    const results = await Promise.allSettled([
      callback(service, original, response),
      callback(service, alternate, response),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(auth.loginFederated).toHaveBeenCalledTimes(1);
  });

  it('cleans the request cache when saving its binding fails', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await expect(start(service)).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.getdel).toHaveBeenCalledWith(redis.set.mock.calls[0][0]);
  });

  it('includes RequestedAuthnContext only when enabled in actual request XML', async () => {
    const enabled = await start(service);
    disableContext = true;
    const disabled = await start(service);

    expect(requestXml(enabled.url)).toContain('RequestedAuthnContext');
    expect(requestXml(disabled.url)).not.toContain('RequestedAuthnContext');
  });
});

async function start(service: SamlService) {
  const result = await service.start(workspaceId, providerId, entityId, callbackUrl);
  return {
    ...result,
    relayState: new URL(result.url).searchParams.get('RelayState') ?? '',
    requestId: requestId(result.url),
  };
}

function callback(
  service: SamlService,
  transaction: Awaited<ReturnType<typeof start>>,
  response: string,
) {
  return service.callback(
    workspaceId,
    providerId,
    entityId,
    callbackUrl,
    response,
    transaction.relayState,
    transaction.binding,
  );
}

function validResponse(inResponseTo: string) {
  return responseFor(inResponseTo);
}

function responseFor(
  inResponseTo: string,
  overrides: Partial<Parameters<typeof signedResponse>[0]> = {},
) {
  const now = new Date();
  return signedResponse({
    audience: entityId,
    destination: callbackUrl,
    inResponseTo,
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    notOnOrAfter: new Date(now.getTime() + 600_000).toISOString(),
    recipient: callbackUrl,
    ...overrides,
  });
}

function requestXml(url: string): string {
  const request = new URL(url).searchParams.get('SAMLRequest') ?? '';
  return inflateRawSync(Buffer.from(request, 'base64')).toString();
}

function redisStore() {
  const values = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    getdel: jest.fn(async (key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    }),
    set: jest.fn(async (key: string, value: string, ...args: string[]) => {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
  };
}

function tamper(response: string): string {
  const xml = Buffer.from(response, 'base64').toString();
  return Buffer.from(xml.replace('Person', 'Tampered')).toString('base64');
}
