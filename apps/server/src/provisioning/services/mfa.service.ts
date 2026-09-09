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
import { EncryptionService } from '../../integrations/encryption/encryption.service';

const CHALLENGE_TTL = 300;
type Challenge = { userId: string; workspaceId: string; method: string };
type PendingSetup = { secret: string };

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
    await this.redis.set(
      this.setupKey(userId, workspaceId),
      JSON.stringify(
        { secret: this.encryption.encrypt(secret) } satisfies PendingSetup,
      ),
      'EX',
      CHALLENGE_TTL,
    );
    return { secret, otpauthUrl: totp.toString() };
  }

  async enable(
    userId: string,
    workspaceId: string,
    code: string,
  ): Promise<void> {
    const pending = await this.consumeSetup(userId, workspaceId);
    if (!this.valid(pending.secret, code))
      throw new BadRequestException('Invalid TOTP code');
    await this.db
      .insertInto('userMfa')
      .values({
        userId,
        workspaceId,
        method: 'totp',
        secret: pending.secret,
        isEnabled: true,
      })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet({
          workspaceId,
          method: 'totp',
          secret: pending.secret,
          isEnabled: true,
        }),
      )
      .execute();
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
    code: string,
  ): Promise<Challenge> {
    const challenge = await this.consumeChallenge(setupId);
    if (challenge.method !== 'totp_setup') {
      throw new UnauthorizedException('Unsupported MFA setup challenge');
    }
    await this.enable(challenge.userId, challenge.workspaceId, code);
    return challenge;
  }

  async verifyChallenge(challengeId: string, code: string): Promise<Challenge> {
    const challenge = await this.consumeChallenge(challengeId);
    if (challenge.method !== 'totp')
      throw new UnauthorizedException('Unsupported MFA challenge');
    const mfa = await this.find(challenge.userId, challenge.workspaceId);
    if (!mfa?.isEnabled || !mfa.secret || !this.valid(mfa.secret, code))
      throw new UnauthorizedException('Invalid TOTP code');
    return challenge;
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
    const raw = await this.redis.get(this.key(challengeId));
    if (!raw) throw new UnauthorizedException('Expired MFA challenge');
    return JSON.parse(raw) as Challenge;
  }
  private async consumeChallenge(challengeId: string): Promise<Challenge> {
    const raw = await this.redis.getdel(this.key(challengeId));
    if (!raw) throw new UnauthorizedException('Expired or used MFA challenge');
    return JSON.parse(raw) as Challenge;
  }
  private async consumeSetup(
    userId: string,
    workspaceId: string,
  ): Promise<PendingSetup> {
    const raw = await this.redis.getdel(this.setupKey(userId, workspaceId));
    if (!raw) throw new BadRequestException('Expired MFA setup');
    return JSON.parse(raw) as PendingSetup;
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
  private setupKey(userId: string, workspaceId: string) {
    return `mfa:setup:${workspaceId}:${userId}`;
  }
}
