const mockAuthorize = jest.fn();
const mockValidate = jest.fn();

jest.mock('@node-saml/passport-saml', () => ({
  SAML: jest.fn().mockImplementation((options) => ({
    getAuthorizeUrlAsync: async (...args: unknown[]) => {
      await options.cacheProvider.saveAsync('request-id', 'timestamp');
      return mockAuthorize(...args);
    },
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
  samlEntityId: 'https://idp.example',
  samlCertificate: 'encrypted:certificate',
  settings: { emailVerifiedAttribute: 'email_verified' },
  groupSync: false,
};
const entityId = 'https://app.example/api/sso/saml/provider-id/login';
const callbackUrl =
  'https://app.example/api/sso/saml/provider-id/callback';
const response = Buffer.from(
  `<Response Destination="${callbackUrl}" InResponseTo="request-id"><SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><SubjectConfirmationData Recipient="${callbackUrl}" InResponseTo="request-id" /></SubjectConfirmation></Response>`,
).toString('base64');

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
      {
        getAppSecret: jest.fn().mockReturnValue('test-secret'),
        getSamlDisableRequestedAuthnContext: jest.fn().mockReturnValue(false),
      } as any,
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
        inResponseTo: 'request-id',
        getAssertionXml: () =>
          '<Assertion><Issuer>https://idp.example</Issuer></Assertion>',
      },
    });
  });

  async function start() {
    return service.start(
      'workspace-id',
      provider.id,
      entityId,
      callbackUrl,
    );
  }

  function transaction(binding: string) {
    return JSON.stringify({
      binding: (service as any).hashBinding(binding),
      workspaceId: 'workspace-id',
      providerId: provider.id,
      requestId: 'request-id',
    });
  }

  it('rejects non-HTTPS callback origins before creating a transaction', async () => {
    await expect(
      service.start(
        'workspace-id',
        provider.id,
        entityId,
        'http://app.example/callback',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('creates an opaque RelayState transaction and accepts its browser binding', async () => {
    const result = await start();
    const relayState = mockAuthorize.mock.calls[0][0];
    expect(encryption.decrypt).toHaveBeenCalledWith('encrypted:certificate');
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
    redis.getdel
      .mockResolvedValueOnce(transaction(result.binding))
      .mockResolvedValueOnce('timestamp');

    await expect(
      service.callback(
        'workspace-id',
        provider.id,
        entityId,
        callbackUrl,
        response,
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
        entityId,
        'https://app.example/callback',
        response,
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    redis.getdel.mockResolvedValue(transaction('other-binding'));
    await expect(
      service.callback(
        'workspace-id',
        provider.id,
        entityId,
        'https://app.example/callback',
        response,
        'relay',
        'binding',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects replayed transactions after atomic consumption', async () => {
    redis.getdel
      .mockResolvedValueOnce(transaction('binding'))
      .mockResolvedValueOnce('timestamp')
      .mockResolvedValueOnce(null);
    const callback = () =>
      service.callback(
        'workspace-id',
        provider.id,
        entityId,
        callbackUrl,
        response,
        'relay',
        'binding',
      );

    await expect(callback()).resolves.toEqual({ authToken: 'token' });
    await expect(callback()).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.getdel).toHaveBeenCalledTimes(3);
  });
});
