import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

jest.mock('../../common/helpers', () => ({
  ...jest.requireActual('../../common/helpers'),
  hashPassword: jest.fn(async (code: string) => `hash:${code}`),
}));

import { MfaService } from './mfa.service';

const userId = 'user-a';
const workspaceId = 'workspace-a';
const setupId = 'setup-a';

describe('MfaService challenges', () => {
  let db: any;
  let redis: any;
  let encryption: any;
  let service: MfaService;

  beforeEach(() => {
    ({ db, redis, encryption } = createDependencies());
    service = new MfaService(
      db,
      { getOrThrow: () => redis } as any,
      encryption,
    );
  });

  it('creates a short-lived, random, bound challenge', async () => {
    redis.set.mockResolvedValue('OK');

    const result = await service.createChallenge(userId, workspaceId, 'totp');

    expect(result.challengeId).toBeTruthy();
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(result.challengeId),
      JSON.stringify({ userId, workspaceId, method: 'totp' }),
      'EX',
      300,
      'NX',
    );
  });

  it('keeps a challenge available after invalid TOTP and claims it after valid TOTP', async () => {
    redis.get.mockResolvedValue(challenge());
    redis.eval.mockResolvedValue(1);
    jest.spyOn(service as any, 'find').mockResolvedValue({ isEnabled: true, secret: 'encrypted-secret' });
    jest.spyOn(service as any, 'valid').mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(service.verifyChallenge('challenge', 'bad-code')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.verifyChallenge('challenge', 'valid-code')).resolves.toEqual({ userId, workspaceId, method: 'totp' });

    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('rejects replay after one successful TOTP claim', async () => {
    redis.get.mockResolvedValue(challenge());
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    jest.spyOn(service as any, 'find').mockResolvedValue({ isEnabled: true, secret: 'encrypted-secret' });
    jest.spyOn(service as any, 'valid').mockReturnValue(true);

    await expect(service.verifyChallenge('challenge', '123456')).resolves.toEqual({ userId, workspaceId, method: 'totp' });
    await expect(service.verifyChallenge('challenge', '123456')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows exactly one concurrent valid TOTP claim', async () => {
    const raw = challenge();
    let claimed = false;
    redis.get.mockResolvedValue(raw);
    redis.eval.mockImplementation(async (_script: string, _keys: number, _key: string, value: string) => {
      if (claimed || value !== raw) return 0;
      claimed = true;
      return 1;
    });
    jest.spyOn(service as any, 'find').mockResolvedValue({ isEnabled: true, secret: 'encrypted-secret' });
    jest.spyOn(service as any, 'valid').mockReturnValue(true);

    const results = await Promise.allSettled([
      service.verifyChallenge('challenge', '123456'),
      service.verifyChallenge('challenge', '123456'),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });

  it('requires the current TOTP before replacing an enabled factor', async () => {
    jest.spyOn(service as any, 'find').mockResolvedValue({
      isEnabled: true,
      secret: 'encrypted-secret',
    });
    jest.spyOn(service as any, 'valid').mockReturnValue(false);

    await expect(
      service.setup(userId, workspaceId, 'a@example.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates independent opaque setup attempts with separately bound secrets', async () => {
    redis.set.mockResolvedValue('OK');
    encryption.encrypt.mockImplementation((secret: string) => `sealed:${secret}`);
    jest.spyOn(service as any, 'find').mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      service.setup(userId, workspaceId, 'a@example.com', undefined, true, 'gate-a'),
      service.setup(userId, workspaceId, 'a@example.com', undefined, true, 'gate-b'),
    ]);
    const values = redis.set.mock.calls.map(([, value]: [string, string]) =>
      JSON.parse(value),
    );

    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.attemptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.attemptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.secret).not.toBe(second.secret);
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId,
          workspaceId,
          loginGateId: 'gate-a',
        }),
        expect.objectContaining({
          userId,
          workspaceId,
          loginGateId: 'gate-b',
        }),
      ]),
    );
  });

  it('does not claim a setup attempt when its TOTP is invalid', async () => {
    redis.get.mockResolvedValue(pendingSetup());
    jest.spyOn(service as any, 'valid').mockReturnValue(false);

    await expect(
      service.enable(userId, workspaceId, 'attempt', 'bad-code'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('permits one setup claim and rejects its replay', async () => {
    redis.get.mockResolvedValue(pendingSetup());
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    jest.spyOn(service as any, 'valid').mockReturnValue(true);
    jest
      .spyOn(service as any, 'saveSetup')
      .mockResolvedValue({ backupCodes: ['backup-code'] });

    await expect(
      service.enable(userId, workspaceId, 'attempt', '123456'),
    ).resolves.toEqual({ backupCodes: ['backup-code'] });
    await expect(
      service.enable(userId, workspaceId, 'attempt', '123456'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect((service as any).saveSetup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['userId', 'other-user'],
    ['workspaceId', 'other-workspace'],
    ['loginGateId', 'other-gate'],
  ])('rejects login setup attempts bound to another %s', async (field, value) => {
    redis.get
      .mockResolvedValueOnce(setupChallenge())
      .mockResolvedValueOnce(pendingSetup({ [field]: value }));
    jest.spyOn(service as any, 'valid').mockReturnValue(true);

    await expect(
      service.verifySetupChallenge(setupId, 'attempt', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects a pending setup with an unsupported method before claiming it', async () => {
    redis.get
      .mockResolvedValueOnce(setupChallenge())
      .mockResolvedValueOnce(
        pendingSetup({ loginGateId: setupId, method: 'webauthn' }),
      );

    await expect(
      service.verifySetupChallenge(setupId, 'attempt', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects an unsupported login setup challenge method before claiming it', async () => {
    redis.get.mockResolvedValueOnce(setupChallenge('totp'));

    await expect(
      service.verifySetupChallenge(setupId, 'attempt', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('does not claim either login setup key when its TOTP is invalid', async () => {
    redis.get
      .mockResolvedValueOnce(setupChallenge())
      .mockResolvedValueOnce(pendingSetup({ loginGateId: setupId }));
    jest.spyOn(service as any, 'valid').mockReturnValue(false);

    await expect(
      service.verifySetupChallenge(setupId, 'attempt', 'bad-code'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('does not consume a challenge or backup hash for a wrong backup code', async () => {
    redis.get.mockResolvedValue(challenge());
    const transaction = backupTransaction(['backup-hash']);
    db.transaction.mockReturnValue({
      execute: (callback: (trx: unknown) => unknown) => callback(transaction),
    });
    jest.spyOn(service as any, 'backupIndex').mockResolvedValue(-1);

    await expect(
      service.verifyBackupChallenge('challenge', 'wrong-code'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(redis.eval).not.toHaveBeenCalled();
    expect(transaction.updateTable).not.toHaveBeenCalled();
  });

  it('models one concurrent backup-code use through serialized locked-row reads', async () => {
    redis.get.mockResolvedValue(challenge());
    redis.eval.mockResolvedValue(1);
    const transactions = serializedTransactions(['backup-hash']);
    db.transaction.mockReturnValue({ execute: transactions.execute });
    jest.spyOn(service as any, 'backupIndex').mockImplementation(
      async (...args: unknown[]) => {
        const hashes = args[1];
        return Array.isArray(hashes) && hashes.includes('backup-hash') ? 0 : -1;
      },
    );

    const results = await Promise.allSettled([
      service.verifyBackupChallenge('challenge-a', 'backup-code'),
      service.verifyBackupChallenge('challenge-b', 'backup-code'),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(transactions.items).toHaveLength(2);
    expect(transactions.items[0].forUpdate).toHaveBeenCalledTimes(1);
    expect(transactions.items[1].forUpdate).toHaveBeenCalledTimes(1);
    expect(transactions.items[0].updateTable).toHaveBeenCalledTimes(1);
    expect(transactions.items[1].updateTable).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('returns plaintext backup codes once while persisting only their hashes', async () => {
    redis.get.mockResolvedValue(pendingSetup());
    redis.eval.mockResolvedValue(1);
    jest.spyOn(service as any, 'valid').mockReturnValue(true);

    const enrollment = await service.enable(
      userId,
      workspaceId,
      'attempt',
      '123456',
    );
    const saved = db.values.mock.calls[0][0];

    expect(enrollment.backupCodes).toHaveLength(10);
    expect(saved.backupCodes).toHaveLength(10);
    expect(saved.backupCodes).toEqual(
      enrollment.backupCodes.map((code: string) => `hash:${code}`),
    );
  });
});

function createDependencies() {
  const query: any = {
    values: jest.fn(() => query),
    onConflict: jest.fn((callback) => {
      callback({ column: () => ({ doUpdateSet: jest.fn() }) });
      return query;
    }),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  return {
    db: {
      insertInto: jest.fn(() => query),
      selectFrom: jest.fn(),
      transaction: jest.fn(),
      values: query.values,
    },
    redis: {
      eval: jest.fn(),
      get: jest.fn(),
      getdel: jest.fn(),
      set: jest.fn(),
    },
    encryption: {
      decrypt: jest.fn((secret: string) => secret),
      encrypt: jest.fn((secret: string) => secret),
    },
  };
}

function backupTransaction(
  backupCodes: string[],
  saveCodes?: (backupCodes: string[]) => void,
) {
  const select: any = {
    select: jest.fn(),
    where: jest.fn(),
    forUpdate: jest.fn(),
    executeTakeFirst: jest.fn().mockResolvedValue({
      backupCodes,
      isEnabled: true,
    }),
  };
  select.select.mockReturnValue(select);
  select.where.mockReturnValue(select);
  select.forUpdate.mockReturnValue(select);
  const update: any = {
    set: jest.fn((values: { backupCodes: string[] }) => {
      saveCodes?.(values.backupCodes);
      return update;
    }),
    where: jest.fn(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  update.where.mockReturnValue(update);
  return {
    forUpdate: select.forUpdate,
    selectFrom: jest.fn(() => select),
    updateTable: jest.fn(() => update),
  };
}

function pendingSetup(overrides: Record<string, string> = {}) {
  return JSON.stringify({
    secret: 'encrypted-secret',
    method: 'totp',
    userId,
    workspaceId,
    ...overrides,
  });
}

function serializedTransactions(initialCodes: string[]) {
  let backupCodes = initialCodes;
  let locked = Promise.resolve();
  const items: ReturnType<typeof backupTransaction>[] = [];
  return {
    items,
    execute: (callback: (trx: unknown) => unknown) => {
      const previous = locked;
      let release: () => void = () => undefined;
      locked = new Promise((resolve) => {
        release = resolve;
      });
      return previous.then(async () => {
        const transaction = backupTransaction(backupCodes, (nextCodes) => {
          backupCodes = nextCodes;
        });
        items.push(transaction);
        try {
          return await callback(transaction);
        } finally {
          release();
        }
      });
    },
  };
}

function setupChallenge(method = 'totp_setup') {
  return JSON.stringify({ userId, workspaceId, method });
}

function challenge() {
  return JSON.stringify({ userId, workspaceId, method: 'totp' });
}
