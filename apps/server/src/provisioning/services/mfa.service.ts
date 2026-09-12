import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { InjectKysely } from 'nestjs-kysely';
import { TOTP } from 'otpauth';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { comparePasswordHash, hashPassword } from '../../common/helpers';
import { EncryptionService } from '../../integrations/encryption/encryption.service';

const CHALLENGE_TTL = 300;
const BACKUP_CODE_COUNT = 10;
type Challenge = { userId: string; workspaceId: string; method: string };
type PendingSetup = {
  secret: string;
  method: 'totp';
  userId: string;
  workspaceId: string;
  loginGateId?: string;
};
type PendingValue = { raw: string; value: PendingSetup };
type ChallengeValue = { raw: string; value: Challenge };
type Enrollment = { backupCodes: string[] };
type SetupChallenge = Enrollment & { challenge: Challenge };

const claimSetupScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
const claimLoginSetupScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
return redis.call('DEL', KEYS[1], KEYS[2])
`;
const claimChallengeScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

@Injectable()
export class MfaService {
  private readonly redis: Redis;
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    redisService: RedisService,
    private readonly encryption: EncryptionService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  async setup(
    userId: string,
    workspaceId: string,
    email: string,
    code?: string,
    passwordVerified = false,
    loginGateId?: string,
  ) {
    const current = await this.find(userId, workspaceId);
    if (
      !passwordVerified &&
      (!current?.isEnabled ||
        !code ||
        !current.secret ||
        !this.valid(current.secret, code))
    ) {
      throw new ForbiddenException(
        'A current password or valid TOTP code is required to set up MFA',
      );
    }
    const totp = new TOTP({ issuer: 'Docmost', label: email });
    const secret = totp.secret.base32;
    const attemptId = randomBytes(32).toString('base64url');
    const saved = await this.redis.set(
      this.setupKey(attemptId),
      JSON.stringify(
        {
          secret: this.encryption.encrypt(secret),
          method: 'totp',
          userId,
          workspaceId,
          ...(loginGateId ? { loginGateId } : {}),
        } satisfies PendingSetup,
      ),
      'EX',
      CHALLENGE_TTL,
      'NX',
    );
    if (saved !== 'OK')
      throw new ForbiddenException('Unable to create MFA setup');
    return { attemptId, secret, otpauthUrl: totp.toString() };
  }

  async enable(
    userId: string,
    workspaceId: string,
    attemptId: string,
    code: string,
  ): Promise<Enrollment> {
    const pending = await this.readSetup(attemptId);
    this.assertPending(pending.value, userId, workspaceId);
    if (!this.valid(pending.value.secret, code))
      throw new BadRequestException('Invalid TOTP code');
    if (!(await this.claimSetup(attemptId, pending.raw)))
      throw new BadRequestException('Expired MFA setup');
    return this.saveSetup(userId, workspaceId, pending.value.secret);
  }

  private async saveSetup(
    userId: string,
    workspaceId: string,
    secret: string,
  ): Promise<Enrollment> {
    const backupCodes = this.backupCodes();
    const backupHashes = await Promise.all(backupCodes.map(hashPassword));
    await this.db
      .insertInto('userMfa')
      .values({
        userId,
        workspaceId,
        method: 'totp',
        secret,
        isEnabled: true,
        backupCodes: backupHashes,
      })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet({
          workspaceId,
          method: 'totp',
          secret,
          isEnabled: true,
          backupCodes: backupHashes,
        }),
      )
      .execute();
    return { backupCodes };
  }

  async createChallenge(
    userId: string,
    workspaceId: string,
    method: string,
  ): Promise<{ challengeId: string }> {
    const challengeId = randomBytes(32).toString('base64url');
    const saved = await this.redis.set(
      this.key(challengeId),
      JSON.stringify({ userId, workspaceId, method } satisfies Challenge),
      'EX',
      CHALLENGE_TTL,
      'NX',
    );
    if (saved !== 'OK')
      throw new ForbiddenException('Unable to create MFA challenge');
    return { challengeId };
  }

  async hasEnabledFactor(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    return Boolean((await this.find(userId, workspaceId))?.isEnabled);
  }

  async getSetupChallenge(setupId: string): Promise<Challenge> {
    const challenge = await this.getChallenge(setupId);
    if (challenge.method !== 'totp_setup') {
      throw new UnauthorizedException('Unsupported MFA setup challenge');
    }
    return challenge;
  }

  async verifySetupChallenge(
    setupId: string,
    attemptId: string,
    code: string,
  ): Promise<SetupChallenge> {
    const challenge = await this.readChallenge(setupId);
    this.assertSetupChallenge(challenge.value);
    const pending = await this.readSetup(attemptId);
    this.assertPending(
      pending.value,
      challenge.value.userId,
      challenge.value.workspaceId,
      setupId,
    );
    if (!this.valid(pending.value.secret, code))
      throw new UnauthorizedException('Invalid TOTP code');
    if (
      !(await this.claimLoginSetup(
        setupId,
        attemptId,
        challenge.raw,
        pending.raw,
      ))
    ) {
      throw new UnauthorizedException('Expired or used MFA setup');
    }
    const enrollment = await this.saveSetup(
      challenge.value.userId,
      challenge.value.workspaceId,
      pending.value.secret,
    );
    return { challenge: challenge.value, ...enrollment };
  }

  async verifyChallenge(challengeId: string, code: string): Promise<Challenge> {
    const challenge = await this.readChallenge(challengeId);
    if (challenge.value.method !== 'totp')
      throw new UnauthorizedException('Unsupported MFA challenge');
    const mfa = await this.find(
      challenge.value.userId,
      challenge.value.workspaceId,
    );
    if (!mfa?.isEnabled || !mfa.secret || !this.valid(mfa.secret, code))
      throw new UnauthorizedException('Invalid TOTP code');
    if (!(await this.claimChallenge(challengeId, challenge.raw)))
      throw new UnauthorizedException('Expired or used MFA challenge');
    return challenge.value;
  }

  async verifyBackupChallenge(
    challengeId: string,
    code: string,
  ): Promise<Challenge> {
    const challenge = await this.readChallenge(challengeId);
    if (challenge.value.method !== 'totp')
      throw new UnauthorizedException('Invalid MFA challenge');
    return executeTx(this.db, async (trx) => {
      const mfa = await trx
        .selectFrom('userMfa')
        .select(['backupCodes', 'isEnabled'])
        .where('userId', '=', challenge.value.userId)
        .where('workspaceId', '=', challenge.value.workspaceId)
        .where('isEnabled', '=', true)
        .forUpdate()
        .executeTakeFirst();
      const hashes = mfa?.backupCodes;
      const index = await this.backupIndex(code, hashes);
      if (!mfa || !hashes || index === -1)
        throw new UnauthorizedException('Invalid MFA challenge');
      if (!(await this.claimChallenge(challengeId, challenge.raw)))
        throw new UnauthorizedException('Invalid MFA challenge');
      await trx
        .updateTable('userMfa')
        .set({
          backupCodes: hashes.filter((_, item) => item !== index),
        })
        .where('userId', '=', challenge.value.userId)
        .where('workspaceId', '=', challenge.value.workspaceId)
        .execute();
      return challenge.value;
    });
  }

  async disable(
    userId: string,
    workspaceId: string,
    code: string,
  ): Promise<void> {
    const mfa = await this.find(userId, workspaceId);
    if (!mfa?.isEnabled || !mfa.secret || !this.valid(mfa.secret, code))
      throw new ForbiddenException('A valid current TOTP code is required');
    await this.db
      .updateTable('userMfa')
      .set({ isEnabled: false, secret: null, backupCodes: null })
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  private async find(userId: string, workspaceId: string) {
    return this.db
      .selectFrom('userMfa')
      .select(['secret', 'isEnabled'])
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }
  private async getChallenge(challengeId: string): Promise<Challenge> {
    return (await this.readChallenge(challengeId)).value;
  }
  private async readChallenge(challengeId: string): Promise<ChallengeValue> {
    const raw = await this.redis.get(this.key(challengeId));
    if (!raw) throw new UnauthorizedException('Expired MFA challenge');
    return { raw, value: JSON.parse(raw) as Challenge };
  }
  private async consumeChallenge(challengeId: string): Promise<Challenge> {
    const raw = await this.redis.getdel(this.key(challengeId));
    if (!raw) throw new UnauthorizedException('Expired or used MFA challenge');
    return JSON.parse(raw) as Challenge;
  }
  private async readSetup(attemptId: string): Promise<PendingValue> {
    const raw = await this.redis.get(this.setupKey(attemptId));
    if (!raw) throw new BadRequestException('Expired MFA setup');
    return { raw, value: JSON.parse(raw) as PendingSetup };
  }
  private assertPending(
    pending: PendingSetup,
    userId: string,
    workspaceId: string,
    loginGateId?: string,
  ): void {
    if (
      pending.method !== 'totp' ||
      pending.userId !== userId ||
      pending.workspaceId !== workspaceId ||
      pending.loginGateId !== loginGateId
    ) {
      throw new UnauthorizedException('Invalid MFA setup');
    }
  }
  private assertSetupChallenge(challenge: Challenge): void {
    if (challenge.method !== 'totp_setup') {
      throw new UnauthorizedException('Unsupported MFA setup challenge');
    }
  }
  private async claimSetup(attemptId: string, raw: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        claimSetupScript,
        1,
        this.setupKey(attemptId),
        raw,
      )) === 1
    );
  }
  private async claimLoginSetup(
    setupId: string,
    attemptId: string,
    challenge: string,
    pending: string,
  ): Promise<boolean> {
    return (
      (await this.redis.eval(
        claimLoginSetupScript,
        2,
        this.key(setupId),
        this.setupKey(attemptId),
        challenge,
        pending,
      )) === 2
    );
  }
  private async claimChallenge(id: string, raw: string): Promise<boolean> {
    return (
      (await this.redis.eval(claimChallengeScript, 1, this.key(id), raw)) === 1
    );
  }
  private backupCodes(): string[] {
    return Array.from({ length: BACKUP_CODE_COUNT }, () =>
      randomBytes(16).toString('base64url'),
    );
  }
  private async backupIndex(
    code: string,
    hashes: string[] | null | undefined,
  ): Promise<number> {
    if (!hashes) return -1;
    return (
      await Promise.all(hashes.map((hash) => comparePasswordHash(code, hash)))
    ).findIndex(Boolean);
  }
  private valid(secret: string, code: string) {
    return (
      new TOTP({ secret: this.encryption.decrypt(secret) }).validate({
        token: code,
        window: 1,
      }) !== null
    );
  }
  private key(id: string) {
    return `mfa:challenge:${id}`;
  }
  private setupKey(attemptId: string) {
    return `mfa:setup:${attemptId}`;
  }
}
