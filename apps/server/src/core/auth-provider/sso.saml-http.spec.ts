jest.mock('./oidc.service', () => ({
  OidcService: class OidcService {},
}));
jest.mock('./ldap.service', () => ({
  LdapService: class LdapService {},
}));
jest.mock('../auth/services/auth.service', () => ({
  AuthService: class AuthService {},
}));

import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { SsoController } from './sso.controller';
import { SamlService } from './saml.service';
import { AuthProviderService } from './auth-provider.service';
import { AuthService } from '../auth/services/auth.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { DomainService } from '../../integrations/environment/domain.service';
import { SsoCapabilityService } from './sso-capability.service';
import { OidcService } from './oidc.service';
import { LdapService } from './ldap.service';
import {
  requestId,
  signedResponse,
  TEST_IDP_CERTIFICATE,
} from '../../../test/fixtures/saml/saml-signed.fixture';

const workspace = { id: 'workspace-id', hostname: 'workspace' };
const provider = {
  id: 'provider-id',
  type: 'saml',
  samlUrl: 'https://idp.example.test/sso',
  samlEntityId: 'https://idp.example.test',
  samlCertificate: 'encrypted-certificate',
  settings: { emailVerifiedAttribute: 'email_verified' },
  groupSync: false,
};
const entityId = 'https://workspace.example.test/api/sso/saml/provider-id/login';
const callbackUrl =
  'https://workspace.example.test/api/sso/saml/provider-id/callback';

describe('SAML form-post callback', () => {
  let app: NestFastifyApplication;
  let auth: { loginFederated: jest.Mock };
  let values: Map<string, string>;

  beforeAll(async () => {
    auth = { loginFederated: jest.fn().mockResolvedValue({ authToken: 'token' }) };
    values = new Map();
    const redis = {
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
    const module = await Test.createTestingModule({
      controllers: [SsoController],
      providers: [
        SamlService,
        { provide: AuthProviderService, useValue: { findEnabled: jest.fn().mockResolvedValue(provider) } },
        { provide: AuthService, useValue: auth },
        {
          provide: EnvironmentService,
          useValue: {
            getAppSecret: jest.fn().mockReturnValue('test-secret'),
            getCookieExpiresIn: jest.fn().mockReturnValue(new Date(0)),
            getSamlDisableRequestedAuthnContext: jest.fn().mockReturnValue(false),
            isCloud: jest.fn().mockReturnValue(false),
            isHttps: jest.fn().mockReturnValue(true),
            getSubdomainHost: jest.fn(),
          },
        },
        { provide: EncryptionService, useValue: { decrypt: jest.fn().mockReturnValue(TEST_IDP_CERTIFICATE) } },
        { provide: RedisService, useValue: { getOrThrow: jest.fn().mockReturnValue(redis) } },
        { provide: DomainService, useValue: { getUrl: jest.fn().mockReturnValue('https://workspace.example.test') } },
        { provide: SsoCapabilityService, useValue: { assertEnabled: jest.fn() } },
        { provide: OidcService, useValue: {} },
        { provide: LdapService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    app.setGlobalPrefix('api');
    await app.register(fastifyCookie);
    app.getHttpAdapter().getInstance().addHook('onRequest', (request, _reply, done) => {
      (request.raw as typeof request.raw & { workspace?: typeof workspace }).workspace = workspace;
      done();
    });
    await app.init();
  });

  beforeEach(() => {
    auth.loginFederated.mockClear();
    values.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('parses a signed form post and redirects after authentication', async () => {
    const login = await start();
    const response = await callback(login, responseFor(login.requestId));

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://workspace.example.test');
    expect(auth.loginFederated).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered signed form post without authentication', async () => {
    const login = await start();
    const response = await callback(login, tamper(responseFor(login.requestId)));

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('/login?sso_error=1');
    expect(auth.loginFederated).not.toHaveBeenCalled();
  });

  it.each(['SAMLResponse', 'RelayState'])('rejects a missing %s without authentication', async (field) => {
    const login = await start();
    const body = new URLSearchParams({
      RelayState: login.relayState,
      SAMLResponse: responseFor(login.requestId),
    });
    body.delete(field);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sso/saml/provider-id/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookie },
      payload: body.toString(),
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('/login?sso_error=1');
    expect(auth.loginFederated).not.toHaveBeenCalled();
  });

  it('rejects a missing binding cookie without authentication', async () => {
    const login = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/api/sso/saml/provider-id/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        RelayState: login.relayState,
        SAMLResponse: responseFor(login.requestId),
      }).toString(),
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('/login?sso_error=1');
    expect(auth.loginFederated).not.toHaveBeenCalled();
  });

  it('does not handle the legacy generic callback route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sso/provider-id/callback',
    });

    expect(response.statusCode).toBe(404);
    expect(auth.loginFederated).not.toHaveBeenCalled();
  });

  async function start() {
    const response = await app.inject({ method: 'POST', url: '/api/sso/saml/provider-id/login' });
    const cookie = response.headers['set-cookie'];
    const url = JSON.parse(response.body).url;

    expect(response.statusCode).toBe(200);
    expect(cookie).toEqual(expect.stringContaining('samlBinding='));
    return {
      cookie: Array.isArray(cookie) ? cookie[0].split(';')[0] : cookie.split(';')[0],
      requestId: requestId(url),
      relayState: new URL(url).searchParams.get('RelayState') ?? '',
    };
  }

  function callback(login: Awaited<ReturnType<typeof start>>, samlResponse: string) {
    const payload = new URLSearchParams({
      RelayState: login.relayState,
      SAMLResponse: samlResponse,
    }).toString();
    return app.inject({
      method: 'POST',
      url: '/api/sso/saml/provider-id/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookie },
      payload,
    });
  }
});

function responseFor(inResponseTo: string) {
  const now = new Date();
  return signedResponse({
    audience: entityId,
    destination: callbackUrl,
    inResponseTo,
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    notOnOrAfter: new Date(now.getTime() + 600_000).toISOString(),
    recipient: callbackUrl,
  });
}

function tamper(response: string) {
  return Buffer.from(Buffer.from(response, 'base64').toString().replace('Person', 'Tampered')).toString('base64');
}
