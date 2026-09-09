import { BadRequestException, Injectable } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import * as oidc from 'openid-client';
import { fetch } from 'undici';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { AuthProviderService } from './auth-provider.service';
import { AuthService } from '../auth/services/auth.service';
import { readProviderGroups } from './group-sync.util';
import { readOidcIdentity } from './federated-identity';

type OidcState = {
  providerId: string;
  nonce: string;
  verifier: string;
  binding: string;
};
const TTL_MS = 10 * 60 * 1000;

@Injectable()
export class OidcService {
  private readonly redis: Redis;

  constructor(
    private readonly providers: AuthProviderService,
    private readonly encryption: EncryptionService,
    private readonly authService: AuthService,
    private readonly environment: EnvironmentService,
    private readonly outbound: OutboundAgentFactory,
    redisService: RedisService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  async start(workspaceId: string, providerId: string, callbackUrl: string) {
    const provider = await this.providers.findEnabled(workspaceId, providerId);
    if (
      provider.type !== 'oidc' ||
      !provider.oidcIssuer ||
      !provider.oidcClientId
    ) {
      throw new BadRequestException(
        'OIDC provider configuration is incomplete.',
      );
    }
    const secret = provider.oidcClientSecret
      ? this.encryption.decrypt(provider.oidcClientSecret)
      : undefined;
    const config = await this.discover(
      provider.oidcIssuer,
      provider.oidcClientId,
      callbackUrl,
      secret,
    );
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const binding = this.createBinding();
    const saved = await this.redis.set(
      `oidc:${state}`,
      JSON.stringify({ providerId, nonce, verifier, binding }),
      'PX',
      TTL_MS,
      'NX',
    );
    if (saved !== 'OK')
      throw new BadRequestException('Unable to start OIDC login.');
    return {
      binding,
      url: oidc.buildAuthorizationUrl(config, {
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      }),
    };
  }

  async callback(
    workspaceId: string,
    currentUrl: URL,
    callbackUrl: string,
    binding?: string,
  ) {
    const state = currentUrl.searchParams.get('state');
    if (!state) throw new BadRequestException('Missing OIDC state.');
    const raw = await this.redis.getdel(`oidc:${state}`);
    const transaction = raw ? (JSON.parse(raw) as OidcState) : undefined;
    if (!transaction)
      throw new BadRequestException('Invalid or expired OIDC login state.');
    if (!binding || !this.matchesBinding(transaction.binding, binding)) {
      throw new BadRequestException('OIDC login binding does not match.');
    }
    const provider = await this.providers.findEnabled(
      workspaceId,
      transaction.providerId,
    );
    if (!provider.oidcIssuer || !provider.oidcClientId)
      throw new BadRequestException(
        'OIDC provider configuration is incomplete.',
      );
    const secret = provider.oidcClientSecret
      ? this.encryption.decrypt(provider.oidcClientSecret)
      : undefined;
    const config = await this.discover(
      provider.oidcIssuer,
      provider.oidcClientId,
      callbackUrl,
      secret,
    );
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      expectedState: state,
      expectedNonce: transaction.nonce,
      pkceCodeVerifier: transaction.verifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims() as Record<string, unknown>;
    const identity = readOidcIdentity(claims);
    identity.groups = readProviderGroups(provider, claims);
    return this.authService.loginFederated(provider.id, identity, workspaceId);
  }

  private async discover(
    issuer: string,
    clientId: string,
    callbackUrl: string,
    secret: string | undefined,
  ) {
    return oidc.discovery(
      new URL(issuer),
      clientId,
      { redirect_uris: [callbackUrl], response_types: ['code'] },
      secret ? oidc.ClientSecretPost(secret) : undefined,
      { [oidc.customFetch]: this.createFetch() },
    );
  }

  private createFetch(): oidc.CustomFetch {
    return async (url, options) => {
      const lease = await this.outbound.lease(url, undefined, {
        requireHttps: true,
        privateHostnames: this.environment.getOidcPrivateHosts(),
        allowPrivateNetworks: false,
      });
      try {
        const response = await fetch(url, {
          body: options.body,
          headers: options.headers,
          method: options.method,
          signal: options.signal,
          dispatcher: lease.dispatcher,
          redirect: 'error',
        });
        const body = await response.arrayBuffer();
        return new globalThis.Response(body, {
          headers: Object.fromEntries(response.headers.entries()),
          status: response.status,
          statusText: response.statusText,
        });
      } finally {
        await lease.release();
      }
    };
  }

  private createBinding(): string {
    const value = randomBytes(32).toString('base64url');
    const signature = createHmac('sha256', this.environment.getAppSecret())
      .update(value)
      .digest('base64url');
    return `${value}.${signature}`;
  }

  private matchesBinding(expected: string, actual: string): boolean {
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    return (
      expectedBytes.length === actualBytes.length &&
      timingSafeEqual(expectedBytes, actualBytes)
    );
  }
}
