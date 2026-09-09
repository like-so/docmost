const mockAuthorize = jest.fn();
const mockValidate = jest.fn();

jest.mock('@node-saml/passport-saml', () => ({
  SAML: jest.fn().mockImplementation(() => ({
    getAuthorizeUrlAsync: mockAuthorize,
    validatePostResponseAsync: mockValidate,
  })),
}));

import { BadRequestException } from '@nestjs/common';
import { SAML } from '@node-saml/passport-saml';
import { SamlService } from './saml.service';

const provider = {
  id: 'provider-id',
  type: 'saml',
  samlUrl: 'https://idp.example/sso',
  samlCertificate: 'encrypted:certificate',
  settings: { emailVerifiedAttribute: 'email_verified' },
  groupSync: false,
};

describe('SamlService browser binding', () => {
  let redis: { set: jest.Mock; getdel: jest.Mock; get: jest.Mock };
  let auth: { loginFederated: jest.Mock };
  let encryption: { decrypt: jest.Mock };
  let service: SamlService;

  beforeEach(() => {
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      getdel: jest.fn(),
      get: jest.fn(),
    };
    auth = {
      loginFederated: jest.fn().mockResolvedValue({ authToken: 'token' }),
    };
    encryption = { decrypt: jest.fn().mockReturnValue('certificate') };
    service = new SamlService(
      { findEnabled: jest.fn().mockResolvedValue(provider) } as any,
      auth as any,
      { getAppSecret: jest.fn().mockReturnValue('test-secret') } as any,
      encryption as any,
      { getOrThrow: jest.fn().mockReturnValue(redis) } as any,
    );
    mockAuthorize.mockResolvedValue('https://idp.example/authorize');
    mockValidate.mockResolvedValue({
      profile: {
        nameID: 'subject-id',
        mail: 'person@example.com',
        displayName: 'Person',
        email_verified: true,
      },
    });
  });

  async function start() {
    return service.start(
      'workspace-id',
      provider.id,
      'https://app.example/api/sso/provider-id/callback',
    );
  }

  function transaction(binding: string) {
    return JSON.stringify({
      binding: (service as any).hashBinding(binding),
      workspaceId: 'workspace-id',
      providerId: provider.id,
    });
  }

  it('rejects non-HTTPS callback origins before creating a transaction', async () => {
    await expect(
      service.start('workspace-id', provider.id, 'http://app.example/callback'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('creates an opaque RelayState transaction and accepts its browser binding', async () => {
    const result = await start();
    const relayState = mockAuthorize.mock.calls[0][0];
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(result).toEqual({
      url: 'https://idp.example/authorize',
      binding: expect.any(String),
    });
    expect(redis.set).toHaveBeenCalledWith(
      `saml:binding:${relayState}`,
      expect.stringContaining('workspace-id'),
      'EX',
      600,
      'NX',
    );
    redis.getdel.mockResolvedValue(transaction(result.binding));

    await expect(
      service.callback(
        'workspace-id',
        provider.id,
        'https://app.example/api/sso/provider-id/callback',
        'response',
        relayState,
        result.binding,
      ),
    ).resolves.toEqual({ authToken: 'token' });
    expect(auth.loginFederated).toHaveBeenCalledWith(
      provider.id,
      expect.objectContaining({
        subject: 'subject-id',
        email: 'person@example.com',
        emailVerified: true,
        name: 'Person',
      }),
      'workspace-id',
    );
    expect(SAML).toHaveBeenCalledWith(
      expect.objectContaining({ idpCert: 'certificate' }),
    );
    expect(encryption.decrypt).toHaveBeenCalledWith('encrypted:certificate');
  });

  it('rejects missing and mismatched RelayState browser bindings', async () => {
    await expect(
      service.callback(
        'workspace-id',
        provider.id,
        'https://app.example/callback',
        'response',
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    redis.getdel.mockResolvedValue(transaction('other-binding'));
    await expect(
      service.callback(
        'workspace-id',
        provider.id,
        'https://app.example/callback',
        'response',
        'relay',
        'binding',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects replayed transactions after atomic consumption', async () => {
    redis.getdel
      .mockResolvedValueOnce(transaction('binding'))
      .mockResolvedValueOnce(null);
    const callback = () =>
      service.callback(
        'workspace-id',
        provider.id,
        'https://app.example/callback',
        'response',
        'relay',
        'binding',
      );

    await expect(callback()).resolves.toEqual({ authToken: 'token' });
    await expect(callback()).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.getdel).toHaveBeenCalledTimes(2);
  });
});
