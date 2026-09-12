import { MfaController } from './mfa.controller';

describe('MfaController', () => {
  it('requires a server-verified password proof when beginning MFA setup', async () => {
    const mfa = { setup: jest.fn() } as any;
    const auth = { verifyMfaPassword: jest.fn().mockResolvedValue(true) } as any;
    const controller = new MfaController(mfa, auth, {} as any);

    await controller.setup(
      { password: 'password', code: '123456' },
      { id: 'user-id', email: 'person@example.com' } as any,
      { id: 'workspace-id' } as any,
    );

    expect(auth.verifyMfaPassword).toHaveBeenCalledWith(
      'user-id',
      'workspace-id',
      'password',
    );
    expect(mfa.setup).toHaveBeenCalledWith(
      'user-id',
      'workspace-id',
      'person@example.com',
      '123456',
      true,
    );
  });

  it('completes a pending login without accepting a client identity', async () => {
    const mfa = {} as any;
    const auth = {
      completeMfaLogin: jest.fn().mockResolvedValue('session-token'),
    } as any;
    const environment = {
      getCookieExpiresIn: jest.fn().mockReturnValue(new Date()),
      isHttps: jest.fn().mockReturnValue(true),
    } as any;
    const reply = { setCookie: jest.fn() } as any;
    const controller = new MfaController(mfa, auth, environment);

    await controller.challenge(
      { challengeId: 'pending-id', kind: 'totp', code: '123456' },
      reply,
    );

    expect(auth.completeMfaLogin).toHaveBeenCalledWith(
      'pending-id',
      'totp',
      '123456',
    );
    expect(reply.setCookie).toHaveBeenCalledWith(
      'authToken',
      'session-token',
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
  });
});
