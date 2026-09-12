import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { TOTP } from 'otpauth';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { MfaService } from '../src/provisioning/services/mfa.service';
import { hashPassword } from '../src/common/helpers';

const redisUrl = process.env.LIKE157_MFA_REDIS_URL;
const prefix = `like157:mfa:${randomUUID()}:`;
let client: Redis;
let redis: ScopedRedis;

beforeAll(async () => {
  if (!redisUrl) {
    throw new Error(
      'LIKE157_MFA_REDIS_URL is required for this Redis e2e spec.',
    );
  }
  client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await client.connect();
  redis = new ScopedRedis(client, prefix);
});

afterAll(async () => {
  if (!client) return;
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      `${prefix}*`,
      'COUNT',
      100,
    );
    cursor = next;
    if (keys.length) await client.del(...keys);
  } while (cursor !== '0');
  await client.quit();
});

describe('MfaService Redis challenge lifecycle', () => {
  it('retains an invalid TOTP challenge, then permits one valid claim and rejects replay', async () => {
    const secret = new TOTP().secret.base32;
    const service = mfa({ isEnabled: true, secret });
    const { challengeId } = await service.createChallenge(
      'user-a',
      'workspace-a',
      'totp',
    );

    await expect(
      service.verifyChallenge(challengeId, '000000'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      redis.get(`mfa:challenge:${challengeId}`),
    ).resolves.not.toBeNull();

    await expect(
      service.verifyChallenge(challengeId, code(secret)),
    ).resolves.toEqual({
      userId: 'user-a',
      workspaceId: 'workspace-a',
      method: 'totp',
    });
    await expect(redis.get(`mfa:challenge:${challengeId}`)).resolves.toBeNull();
    await expect(
      service.verifyChallenge(challengeId, code(secret)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('permits exactly one concurrent valid Redis challenge claim', async () => {
    const secret = new TOTP().secret.base32;
    const service = mfa({ isEnabled: true, secret });
    const { challengeId } = await service.createChallenge(
      'user-a',
      'workspace-a',
      'totp',
    );

    const results = await Promise.allSettled([
      service.verifyChallenge(challengeId, code(secret)),
      service.verifyChallenge(challengeId, code(secret)),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('rejects cross-user, cross-workspace, and login-gate setup attempts without claiming Redis state', async () => {
    const service = mfa();
    const setup = await service.setup(
      'user-a',
      'workspace-a',
      'user@example.com',
      undefined,
      true,
      'gate-a',
    );

    await expect(
      service.enable(
        'user-b',
        'workspace-a',
        setup.attemptId,
        code(setup.secret),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.enable(
        'user-a',
        'workspace-b',
        setup.attemptId,
        code(setup.secret),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      redis.get(`mfa:setup:${setup.attemptId}`),
    ).resolves.not.toBeNull();

    const { challengeId } = await service.createChallenge(
      'user-a',
      'workspace-a',
      'totp_setup',
    );
    const mismatched = await service.setup(
      'user-a',
      'workspace-a',
      'user@example.com',
      undefined,
      true,
      'other-gate',
    );

    await expect(
      service.verifySetupChallenge(
        challengeId,
        mismatched.attemptId,
        code(mismatched.secret),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      redis.get(`mfa:challenge:${challengeId}`),
    ).resolves.not.toBeNull();
    await expect(
      redis.get(`mfa:setup:${mismatched.attemptId}`),
    ).resolves.not.toBeNull();
  });

  it('burns a backup challenge after a real Redis claim when the injected database update fails', async () => {
    const backupCode = 'like-157-backup-code';
    const service = new MfaService(
      backupFailureDatabase(
        await hashPassword(backupCode),
        new Error('simulated backup persistence failure'),
      ) as any,
      { getOrThrow: () => redis } as any,
      {
        decrypt: (value: string) => value,
        encrypt: (value: string) => value,
      } as any,
    );
    const { challengeId } = await service.createChallenge(
      'user-a',
      'workspace-a',
      'totp',
    );

    await expect(
      service.verifyBackupChallenge(challengeId, backupCode),
    ).rejects.toThrow('simulated backup persistence failure');
    await expect(redis.get(`mfa:challenge:${challengeId}`)).resolves.toBeNull();
    await expect(
      service.verifyBackupChallenge(challengeId, backupCode),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('burns a setup attempt after a real Redis claim when the injected persistence boundary fails', async () => {
    const service = mfa(undefined, new Error('simulated persistence failure'));
    const setup = await service.setup(
      'user-a',
      'workspace-a',
      'user@example.com',
      undefined,
      true,
    );

    await expect(
      service.enable(
        'user-a',
        'workspace-a',
        setup.attemptId,
        code(setup.secret),
      ),
    ).rejects.toThrow('simulated persistence failure');
    await expect(redis.get(`mfa:setup:${setup.attemptId}`)).resolves.toBeNull();
    await expect(
      service.enable(
        'user-a',
        'workspace-a',
        setup.attemptId,
        code(setup.secret),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function code(secret: string): string {
  return new TOTP({ secret }).generate();
}

function mfa(
  factor?: { isEnabled: boolean; secret: string },
  persistenceError?: Error,
): MfaService {
  return new MfaService(
    database(factor, persistenceError) as any,
    { getOrThrow: () => redis } as any,
    {
      decrypt: (value: string) => value,
      encrypt: (value: string) => value,
    } as any,
  );
}

function database(
  factor?: { isEnabled: boolean; secret: string },
  persistenceError?: Error,
) {
  const select: any = {
    select: () => select,
    where: () => select,
    executeTakeFirst: async () => factor,
  };
  const insert: any = {
    values: () => insert,
    onConflict: (
      callback: (conflict: {
        column: () => { doUpdateSet: () => void };
      }) => void,
    ) => {
      callback({ column: () => ({ doUpdateSet: () => undefined }) });
      return insert;
    },
    execute: async () => {
      if (persistenceError) throw persistenceError;
    },
  };
  return {
    insertInto: () => insert,
    selectFrom: () => select,
  };
}

class ScopedRedis {
  constructor(
    private readonly raw: Redis,
    private readonly keyPrefix: string,
  ) {}

  get(key: string) {
    return this.raw.get(this.key(key));
  }

  set(key: string, value: string, ...args: Array<string | number>) {
    return (
      this.raw.set as unknown as (
        key: string,
        value: string,
        ...options: Array<string | number>
      ) => Promise<'OK' | null>
    )(this.key(key), value, ...args);
  }

  eval(script: string, keyCount: number, ...args: string[]) {
    return this.raw.eval(
      script,
      keyCount,
      ...args.map((value, index) =>
        index < keyCount ? this.key(value) : value,
      ),
    );
  }

  private key(value: string) {
    return `${this.keyPrefix}${value}`;
  }
}

function backupFailureDatabase(backupCode: string, error: Error) {
  const select: any = {
    select: () => select,
    where: () => select,
    forUpdate: () => select,
    executeTakeFirst: async () => ({
      backupCodes: [backupCode],
      isEnabled: true,
    }),
  };
  const update: any = {
    set: () => update,
    where: () => update,
    execute: async () => {
      throw error;
    },
  };
  const transaction = {
    selectFrom: () => select,
    updateTable: () => update,
  };
  return {
    transaction: () => ({
      execute: (callback: (trx: unknown) => unknown) => callback(transaction),
    }),
  };
}
