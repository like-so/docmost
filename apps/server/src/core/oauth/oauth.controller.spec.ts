import { OAuthController } from './oauth.controller';

describe('OAuthController authorization transaction', () => {
  const user = { id: 'user', workspaceId: 'workspace' } as any;
  const reply = { redirect: jest.fn() } as any;

  function controller() {
    return new OAuthController(
      {
        startAuthorization: jest.fn().mockResolvedValue({
          transaction: 'transaction',
          csrf: 'csrf',
          scope: 'read write',
        }),
        confirmAuthorization: jest.fn().mockResolvedValue({
          redirectUri: 'https://client.example/callback?code=code',
        }),
      } as any,
      {
        getAppUrl: jest.fn().mockReturnValue('https://docmost.example'),
      } as any,
    );
  }

  it('GET only creates an opaque authorization transaction', async () => {
    const subject = controller();
    await subject.authorize(
      user,
      { raw: { sessionId: 'session' } } as any,
      {
        response_type: 'code',
        client_id: 'client',
        redirect_uri: 'https://client.example/callback',
        scope: 'read',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        state: 'state',
      },
      reply,
    );
    expect(
      (subject as any).oauthService.startAuthorization,
    ).toHaveBeenCalledWith(
      user,
      'session',
      expect.objectContaining({ clientId: 'client', state: 'state' }),
    );
    expect(reply.redirect).toHaveBeenCalledWith(
      '/oauth/consent?transaction=transaction&csrf=csrf&scope=read+write',
    );
  });

  it('requires same-origin POST confirmation with the session-bound transaction', async () => {
    const subject = controller();
    const request = {
      raw: { sessionId: 'session' },
      headers: { origin: 'https://docmost.example' },
    } as any;
    await expect(
      subject.confirm(user, request, {
        transaction: 'transaction',
        csrf: 'csrf',
        decision: 'allow',
      }),
    ).resolves.toEqual({
      redirectUri: 'https://client.example/callback?code=code',
    });
    expect(
      (subject as any).oauthService.confirmAuthorization,
    ).toHaveBeenCalledWith(user, 'session', 'transaction', 'csrf', true);
    request.headers.origin = 'https://attacker.example';
    await expect(
      subject.confirm(user, request, {
        transaction: 'transaction',
        csrf: 'csrf',
        decision: 'deny',
      }),
    ).rejects.toThrow('invalid_origin');
  });
});
