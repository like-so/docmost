import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { MfaService } from './mfa.service';

describe('MfaService challenges', () => {
  const redis = { set: jest.fn(), getdel: jest.fn() };
  const db = { insertInto: jest.fn(), selectFrom: jest.fn() };
  const encryption = { encrypt: jest.fn(), decrypt: jest.fn() };
  const service = new MfaService(
    db as any,
    { getOrThrow: () => redis } as any,
    encryption as any,
  );

  beforeEach(() => jest.clearAllMocks());
  it('creates a short-lived, random, bound challenge', async () => {
    redis.set.mockResolvedValue('OK');
    const result = await service.createChallenge(
      'user-a',
      'workspace-a',
      'totp',
    );
    expect(result.challengeId).toBeTruthy();
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(result.challengeId),
      JSON.stringify({
        userId: 'user-a',
        workspaceId: 'workspace-a',
        method: 'totp',
      }),
      'EX',
      300,
      'NX',
    );
  });
  it('rejects expired or replayed challenge IDs before TOTP lookup', async () => {
    redis.getdel.mockResolvedValue(null);
    await expect(
      service.verifyChallenge('used', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.selectFrom).not.toHaveBeenCalled();
  });
  it('uses only the server-bound challenge identity and consumes it first', async () => {
    redis.getdel.mockResolvedValue(
      JSON.stringify({
        userId: 'user-a',
        workspaceId: 'workspace-a',
        method: 'totp',
      }),
    );
    db.selectFrom.mockReturnValue({
      select: () => ({
        where: () => ({
          where: () => ({
            executeTakeFirst: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      }),
    });
    await expect(
      service.verifyChallenge('id', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.getdel).toHaveBeenCalledTimes(1);
  });

  it('rejects challenges for unsupported methods after consuming them', async () => {
    redis.getdel.mockResolvedValue(
      JSON.stringify({
        userId: 'user-a',
        workspaceId: 'workspace-a',
        method: 'webauthn',
      }),
    );
    await expect(
      service.verifyChallenge('id', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it('requires the current TOTP before replacing an enabled factor', async () => {
    jest.spyOn(service as any, 'find').mockResolvedValue({
      isEnabled: true,
      secret: 'encrypted-secret',
    });
    jest.spyOn(service as any, 'valid').mockReturnValue(false);

    await expect(
      service.setup('user-a', 'workspace-a', 'a@example.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stores an encrypted pending setup without replacing an enabled factor', async () => {
    jest.spyOn(service as any, 'find').mockResolvedValue({
      isEnabled: true,
      secret: 'encrypted-secret',
    });
    jest.spyOn(service as any, 'valid').mockReturnValue(true);
    encryption.encrypt.mockImplementation((value) => `encrypted:${value}`);

    await service.setup('user-a', 'workspace-a', 'a@example.com', '123456');

    expect(redis.set).toHaveBeenCalledWith(
      'mfa:setup:workspace-a:user-a',
      expect.stringContaining('encrypted:'),
      'EX',
      300,
    );
    expect(db.insertInto).not.toHaveBeenCalled();
  });
});
