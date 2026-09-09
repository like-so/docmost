import { BadRequestException, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { SAML } from '@node-saml/passport-saml';
import type { CacheItem, CacheProvider } from '@node-saml/node-saml';
import type { Redis } from 'ioredis';
import { AuthService } from '../auth/services/auth.service';
import { AuthProviderService } from './auth-provider.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { buildSamlOptions } from './federation.config';
import { readProviderGroups } from './group-sync.util';
import { readSamlIdentity } from './federated-identity';

const TTL_SECONDS = 600;

@Injectable()
export class SamlService {
  private readonly redis: Redis;
  constructor(
    private readonly providers: AuthProviderService,
    private readonly auth: AuthService,
    private readonly environment: EnvironmentService,
    private readonly encryption: EncryptionService,
    redisService: RedisService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  async start(workspaceId: string, providerId: string, callbackUrl: string) {
    const provider = await this.providers.findEnabled(workspaceId, providerId);
    if (provider.type !== 'saml')
      throw new BadRequestException('Provider is not SAML.');
    if (new URL(callbackUrl).protocol !== 'https:') {
      throw new BadRequestException('SAML callbacks must use HTTPS.');
    }
    const relayState = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    const saved = await this.redis.set(
      this.bindingKey(relayState),
      JSON.stringify({
        binding: this.hashBinding(binding),
        workspaceId,
        providerId,
      }),
      'EX',
      TTL_SECONDS,
      'NX',
    );
    if (saved !== 'OK')
      throw new BadRequestException('Unable to start SAML login.');
    const url = await new SAML({
      ...buildSamlOptions(provider, callbackUrl, false),
      cacheProvider: this.cache(workspaceId, providerId),
    }).getAuthorizeUrlAsync(relayState, undefined, {});
    return { url, binding };
  }

  async callback(
    workspaceId: string,
    providerId: string,
    callbackUrl: string,
    response: string,
    relayState: string | undefined,
    binding: string | undefined,
  ) {
    await this.consumeBinding(workspaceId, providerId, relayState, binding);
    const provider = await this.providers.findEnabled(workspaceId, providerId);
    if (provider.type !== 'saml')
      throw new BadRequestException('Provider is not SAML.');
    const saml = new SAML({
      ...buildSamlOptions(this.decryptCertificate(provider), callbackUrl),
      cacheProvider: this.cache(workspaceId, providerId),
    });
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: response,
    });
    if (!profile)
      throw new BadRequestException('SAML assertion has no subject.');
    const identity = readSamlIdentity(
      profile as Record<string, unknown>,
      provider.settings,
    );
    identity.groups = readProviderGroups(
      provider,
      profile as Record<string, unknown>,
    );
    return this.auth.loginFederated(provider.id, identity, workspaceId);
  }

  private async consumeBinding(
    workspaceId: string,
    providerId: string,
    relayState: string | undefined,
    binding: string | undefined,
  ): Promise<void> {
    if (!relayState || !binding)
      throw new BadRequestException('Missing SAML login binding.');
    const raw = await this.redis.getdel(this.bindingKey(relayState));
    if (!raw)
      throw new BadRequestException('Invalid or expired SAML login binding.');
    const transaction = JSON.parse(raw) as {
      binding: string;
      workspaceId: string;
      providerId: string;
    };
    const expected = Buffer.from(transaction.binding);
    const actual = Buffer.from(this.hashBinding(binding));
    if (
      transaction.workspaceId !== workspaceId ||
      transaction.providerId !== providerId ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new BadRequestException('SAML login binding does not match.');
    }
  }

  private hashBinding(binding: string): string {
    return createHmac('sha256', this.environment.getAppSecret())
      .update(binding)
      .digest('base64url');
  }

  private bindingKey(relayState: string): string {
    return `saml:binding:${relayState}`;
  }

  private cache(workspaceId: string, providerId: string): CacheProvider {
    const prefix = `saml:${workspaceId}:${providerId}:`;
    return {
      saveAsync: async (key, value) => {
        const saved = await this.redis.set(
          prefix + key,
          value,
          'EX',
          TTL_SECONDS,
          'NX',
        );
        return saved === 'OK' ? { value, createdAt: Date.now() } : null;
      },
      getAsync: async (key) => this.redis.get(prefix + key),
      removeAsync: async (key) =>
        key ? ((await this.redis.getdel(prefix + key)) ?? null) : null,
    };
  }

  private decryptCertificate(
    provider: Awaited<ReturnType<AuthProviderService['findEnabled']>>,
  ) {
    if (!provider.samlCertificate) return provider;
    return {
      ...provider,
      samlCertificate: this.encryption.decrypt(provider.samlCertificate),
    };
  }
}
