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
import { validateSamlIssuer, validateSamlPost } from './saml-validation.util';

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

  async start(
    workspaceId: string,
    providerId: string,
    entityId: string,
    callbackUrl: string,
  ) {
    const provider = await this.providers.findEnabled(workspaceId, providerId);
    if (provider.type !== 'saml')
      throw new BadRequestException('Provider is not SAML.');
    if (new URL(callbackUrl).protocol !== 'https:') {
      throw new BadRequestException('SAML callbacks must use HTTPS.');
    }
    const relayState = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    let requestId = '';
    const url = await new SAML({
      ...buildSamlOptions(
        this.decryptCertificate(provider),
        entityId,
        callbackUrl,
        this.environment.getSamlDisableRequestedAuthnContext(),
      ),
      cacheProvider: this.cache(workspaceId, providerId, (key) => {
        requestId = key;
      }),
    }).getAuthorizeUrlAsync(relayState, undefined, {});
    if (!requestId)
      throw new BadRequestException('Unable to start SAML login.');
    await this.saveBinding({
      binding,
      providerId,
      relayState,
      requestId,
      workspaceId,
    });
    return { url, binding };
  }

  async callback(
    workspaceId: string,
    providerId: string,
    entityId: string,
    callbackUrl: string,
    response: string,
    relayState: string | undefined,
    binding: string | undefined,
  ) {
    const transaction = await this.consumeBinding(
      workspaceId,
      providerId,
      relayState,
      binding,
    );
    const provider = await this.providers.findEnabled(workspaceId, providerId);
    if (provider.type !== 'saml')
      throw new BadRequestException('Provider is not SAML.');
    const saml = new SAML({
      ...buildSamlOptions(
        this.decryptCertificate(provider),
        entityId,
        callbackUrl,
        this.environment.getSamlDisableRequestedAuthnContext(),
      ),
      cacheProvider: this.claimedCache(
        transaction.requestId,
        await this.claimRequest(
          workspaceId,
          providerId,
          transaction.requestId,
        ),
      ),
    });
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: response,
    });
    if (!profile)
      throw new BadRequestException('SAML assertion has no subject.');
    if (!provider.samlEntityId)
      throw new BadRequestException('SAML provider configuration is incomplete.');
    validateSamlPost(response, callbackUrl, profile as Record<string, unknown>);
    validateSamlIssuer(
      response,
      provider.samlEntityId,
      profile as Record<string, unknown>,
    );
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
  ): Promise<{ requestId: string }> {
    if (!relayState || !binding)
      throw new BadRequestException('Missing SAML login binding.');
    const raw = await this.redis.getdel(this.bindingKey(relayState));
    if (!raw)
      throw new BadRequestException('Invalid or expired SAML login binding.');
    const transaction = JSON.parse(raw) as {
      binding: string;
      workspaceId: string;
      providerId: string;
      requestId: string;
    };
    const expected = Buffer.from(transaction.binding);
    const actual = Buffer.from(this.hashBinding(binding));
    if (
      transaction.workspaceId !== workspaceId ||
      transaction.providerId !== providerId ||
      !transaction.requestId ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new BadRequestException('SAML login binding does not match.');
    }
    return { requestId: transaction.requestId };
  }

  private async saveBinding(transaction: {
    binding: string;
    providerId: string;
    relayState: string;
    requestId: string;
    workspaceId: string;
  }): Promise<void> {
    let saved = false;
    try {
      saved =
        (await this.redis.set(
          this.bindingKey(transaction.relayState),
          JSON.stringify({
            binding: this.hashBinding(transaction.binding),
            providerId: transaction.providerId,
            requestId: transaction.requestId,
            workspaceId: transaction.workspaceId,
          }),
          'EX',
          TTL_SECONDS,
          'NX',
        )) === 'OK';
      if (!saved) throw new BadRequestException('Unable to start SAML login.');
    } finally {
      if (!saved)
        await this.redis.getdel(
          this.requestKey(
            transaction.workspaceId,
            transaction.providerId,
            transaction.requestId,
          ),
        );
    }
  }

  private async claimRequest(
    workspaceId: string,
    providerId: string,
    requestId: string,
  ): Promise<string> {
    const timestamp = await this.redis.getdel(
      this.requestKey(workspaceId, providerId, requestId),
    );
    if (!timestamp) throw new BadRequestException('Invalid SAML response.');
    return timestamp;
  }

  private hashBinding(binding: string): string {
    return createHmac('sha256', this.environment.getAppSecret())
      .update(binding)
      .digest('base64url');
  }

  private bindingKey(relayState: string): string {
    return `saml:binding:${relayState}`;
  }

  private requestKey(
    workspaceId: string,
    providerId: string,
    requestId: string,
  ): string {
    return `saml:${workspaceId}:${providerId}:${requestId}`;
  }

  private cache(
    workspaceId: string,
    providerId: string,
    savedRequest?: (key: string) => void,
  ): CacheProvider {
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
        if (saved !== 'OK') return null;
        savedRequest?.(key);
        return { value, createdAt: Date.now() };
      },
      getAsync: async (key) => this.redis.get(prefix + key),
      removeAsync: async (key) =>
        key ? ((await this.redis.getdel(prefix + key)) ?? null) : null,
    };
  }

  private claimedCache(requestId: string, timestamp: string): CacheProvider {
    return {
      saveAsync: async () => null,
      getAsync: async (key) => (key === requestId ? timestamp : null),
      removeAsync: async (key) => (key === requestId ? timestamp : null),
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
