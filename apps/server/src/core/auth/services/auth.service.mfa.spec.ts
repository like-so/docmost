import { AuthService } from './auth.service';

describe('AuthService MFA login completion', () => {
  it('returns a pending challenge without creating a session', async () => {
    const sessions = { createSessionAndToken: jest.fn() };
    const gate = { requiresChallenge: jest.fn().mockResolvedValue(true) };
    const mfa = {
      hasEnabledFactor: jest.fn().mockResolvedValue(true),
      createChallenge: jest
        .fn()
        .mockResolvedValue({ challengeId: 'pending-id' }),
    };
    const service = new AuthService(
      {} as any,
      {} as any,
      sessions as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      gate as any,
      mfa as any,
      { syncUserGroups: jest.fn() } as any,
      {} as any,
      {} as any,
    );

    await expect(
      (service as any).completeLogin({ id: 'user-id' }, 'workspace-id'),
    ).resolves.toEqual({ mfaRequired: true, challengeId: 'pending-id' });

    expect(mfa.createChallenge).toHaveBeenCalledWith(
      'user-id',
      'workspace-id',
      'totp',
    );
    expect(sessions.createSessionAndToken).not.toHaveBeenCalled();
  });
});
