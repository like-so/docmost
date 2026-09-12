jest.mock('openid-client', () => ({
  ClientSecretPost: jest.fn(),
  authorizationCodeGrant: jest.fn(),
  buildAuthorizationUrl: jest.fn(),
  calculatePKCECodeChallenge: jest.fn(),
  discovery: jest.fn(),
  randomNonce: jest.fn(),
  randomPKCECodeVerifier: jest.fn(),
  randomState: jest.fn(),
  customFetch: Symbol('customFetch'),
}));

import * as oidc from 'openid-client';
import { BadRequestException } from '@nestjs/common';
import { OidcService } from './oidc.service';

const provider = {
  id: 'provider-id',
  type: 'oidc',
  oidcIssuer: 'https://issuer.example',
  oidcClientId: 'client-id',
  oidcClientSecret: null,
};

describe('OidcService browser binding', () => {
  let redis: jest.Mocked<{ set: jest.Mock; getdel: jest.Mock }>;
  let auth: { loginFederated: jest.Mock };
  let service: OidcService;

  beforeEach(() => {
    redis = { set: jest.fn().mockResolvedValue('OK'), getdel: jest.fn() };
    auth = {
      loginFederated: jest.fn().mockResolvedValue({ authToken: 'token' }),
    };
    service = new OidcService(
      { findEnabled: jest.fn().mockResolvedValue(provider) } as any,
      { decrypt: jest.fn() } as any,
      auth as any,
      {
        getAppSecret: jest.fn().mockReturnValue('test-secret'),
        getOidcPrivateHosts: jest.fn().mockReturnValue(['idp.internal']),
      } as any,
      { lease: jest.fn() } as any,
      { getOrThrow: jest.fn().mockReturnValue(redis) } as any,
    );
    jest.mocked(oidc.discovery).mockResolvedValue({} as any);
    jest.mocked(oidc.randomState).mockReturnValue('state-id');
    jest.mocked(oidc.randomNonce).mockReturnValue('nonce');
    jest.mocked(oidc.randomPKCECodeVerifier).mockReturnValue('verifier');
    jest.mocked(oidc.calculatePKCECodeChallenge).mockResolvedValue('challenge');
    jest
      .mocked(oidc.buildAuthorizationUrl)
      .mockReturnValue(new URL('https://issuer.example/authorize'));
    jest.mocked(oidc.authorizationCodeGrant).mockResolvedValue({
      claims: () => ({
        sub: 'subject-id',
        email: 'person@example.com',
        email_verified: true,
        name: 'Person',
      }),
    } as any);
  });

  async function start(): Promise<string> {
    const result = await service.start(
      'workspace-id',
      provider.id,
      'https://app.example/api/sso/provider-id/callback',
    );
    return result.binding;
  }

  it('configures discovery with the pinned HTTPS-only fetch capability', async () => {
    await start();

    const options = jest.mocked(oidc.discovery).mock.calls[0][4] as Record<
      symbol,
      unknown
    >;
    expect(typeof options[oidc.customFetch]).toBe('function');
  });

  it('accepts the binding created for the browser transaction', async () => {
    const binding = await start();
    redis.getdel.mockResolvedValue(
      JSON.stringify({
        providerId: provider.id,
        nonce: 'nonce',
        verifier: 'verifier',
        binding,
      }),
    );

    await expect(
      service.callback(
        'workspace-id',
        new URL(
          'https://app.example/api/sso/provider-id/callback?state=state-id',
        ),
        'https://app.example/api/sso/provider-id/callback',
        binding,
      ),
    ).resolves.toEqual({ authToken: 'token' });
    expect(redis.getdel).toHaveBeenCalledWith('oidc:state-id');
    expect(auth.loginFederated).toHaveBeenCalledWith(
      provider.id,
      {
        subject: 'subject-id',
        email: 'person@example.com',
        emailVerified: true,
        name: 'Person',
        groups: undefined,
      },
      'workspace-id',
    );
  });

  it('does not mark an unverified OIDC email as trusted', async () => {
    const binding = await start();
    redis.getdel.mockResolvedValue(
      JSON.stringify({
        providerId: provider.id,
        nonce: 'nonce',
        verifier: 'verifier',
        binding,
      }),
    );
    jest.mocked(oidc.authorizationCodeGrant).mockResolvedValue({
      claims: () => ({ sub: 'subject-id', email: 'person@example.com' }),
    } as any);

    await service.callback(
      'workspace-id',
      new URL('https://app.example/callback?state=state-id'),
      'https://app.example/callback',
      binding,
    );

    expect(auth.loginFederated.mock.calls[0][1]).toMatchObject({
      emailVerified: false,
    });
  });

  it('rejects a missing or mismatched browser binding after consuming state', async () => {
    redis.getdel.mockResolvedValue(
      JSON.stringify({
        providerId: provider.id,
        nonce: 'nonce',
        verifier: 'verifier',
        binding: 'signed-binding',
      }),
    );

    await expect(
      service.callback(
        'workspace-id',
        new URL('https://app.example/callback?state=state-id'),
        'https://app.example/callback',
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.callback(
        'workspace-id',
        new URL('https://app.example/callback?state=state-id'),
        'https://app.example/callback',
        'other-binding',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.getdel).toHaveBeenCalledWith('oidc:state-id');
  });

  it('rejects a replay after Redis atomically consumes the transaction', async () => {
    const transaction = JSON.stringify({
      providerId: provider.id,
      nonce: 'nonce',
      verifier: 'verifier',
      binding: 'signed-binding',
    });
    redis.getdel.mockResolvedValueOnce(transaction).mockResolvedValueOnce(null);
    const callback = new URL('https://app.example/callback?state=state-id');

    await expect(
      service.callback(
        'workspace-id',
        callback,
        'https://app.example/callback',
        'signed-binding',
      ),
    ).resolves.toEqual({ authToken: 'token' });
    await expect(
      service.callback(
        'workspace-id',
        callback,
        'https://app.example/callback',
        'signed-binding',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.getdel).toHaveBeenCalledTimes(2);
  });

  it('rejects replayed, expired, and missing state before identity mapping', async () => {
    redis.getdel.mockResolvedValueOnce(null);
    await expect(
      service.callback(
        'workspace-id',
        new URL('https://app.example/callback?state=state-id'),
        'https://app.example/callback',
        'binding',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.callback(
        'workspace-id',
        new URL('https://app.example/callback'),
        'https://app.example/callback',
        'binding',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(auth.loginFederated).not.toHaveBeenCalled();
  });
});
