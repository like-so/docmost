jest.mock('./oidc.service', () => ({ OidcService: class OidcService {} }));

import { SsoController } from './sso.controller';

describe('SsoController callbacks', () => {
  const workspace = { id: 'workspace-id', hostname: 'team' } as any;
  let oidc: any;
  let saml: any;
  let reply: any;
  let controller: SsoController;

  beforeEach(() => {
    oidc = { callback: jest.fn().mockResolvedValue({ authToken: 'token' }) };
    saml = { callback: jest.fn().mockResolvedValue({ authToken: 'token' }) };
    reply = {
      clearCookie: jest.fn(),
      redirect: jest.fn(),
      setCookie: jest.fn(),
    };
    controller = new SsoController(
      oidc,
      {
        getAppUrl: () => 'https://app.example',
        getCookieExpiresIn: jest.fn(),
        getSubdomainHost: () => undefined,
        isCloud: () => false,
        isHttps: () => true,
      } as any,
      { getUrl: () => 'https://workspace.example' } as any,
      { assertEnabled: jest.fn() } as any,
      {} as any,
      saml,
      {} as any,
    );
  });

  it('sets the auth cookie and redirects an OIDC callback to the workspace URL', async () => {
    await controller.callback(
      'provider-id',
      { url: '/api/sso/provider-id/callback?code=code', cookies: {} } as any,
      reply,
      workspace,
    );

    expect(reply.setCookie).toHaveBeenCalledWith('authToken', 'token', expect.objectContaining({ httpOnly: true }));
    expect(reply.redirect).toHaveBeenCalledWith('https://workspace.example');
  });

  it('sets the auth cookie and redirects a SAML callback to the workspace URL', async () => {
    await controller.samlCallback(
      'provider-id',
      { SAMLResponse: 'response' },
      { cookies: {} } as any,
      reply,
      workspace,
    );

    expect(reply.setCookie).toHaveBeenCalledWith('authToken', 'token', expect.objectContaining({ httpOnly: true }));
    expect(reply.redirect).toHaveBeenCalledWith('https://workspace.example');
  });

  it('clears the OIDC binding and redirects callback failures without provider details', async () => {
    oidc.callback.mockRejectedValue(new Error('provider assertion details'));

    await controller.callback(
      'provider-id',
      { url: '/api/sso/provider-id/callback?code=code', cookies: {} } as any,
      reply,
      workspace,
    );

    expect(reply.clearCookie).toHaveBeenCalledWith('oidcBinding', {
      path: '/api/sso/provider-id/callback',
    });
    expect(reply.redirect).toHaveBeenCalledWith(
      'https://workspace.example/login?sso_error=1',
    );
    expect(reply.clearCookie.mock.invocationCallOrder[0]).toBeLessThan(
      reply.redirect.mock.invocationCallOrder[0],
    );
  });

  it('clears the SAML binding and redirects callback failures without provider details', async () => {
    saml.callback.mockRejectedValue(new Error('provider assertion details'));

    await controller.samlCallback(
      'provider-id',
      { SAMLResponse: 'response' },
      { cookies: {} } as any,
      reply,
      workspace,
    );

    expect(reply.clearCookie).toHaveBeenCalledWith('samlBinding', {
      path: '/api/sso/provider-id/callback',
    });
    expect(reply.redirect).toHaveBeenCalledWith(
      'https://workspace.example/login?sso_error=1',
    );
    expect(reply.clearCookie.mock.invocationCallOrder[0]).toBeLessThan(
      reply.redirect.mock.invocationCallOrder[0],
    );
  });
});
