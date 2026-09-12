import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Client } from 'ldapts';
import { AuthService } from '../auth/services/auth.service';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { OutboundUrlGuard } from '../../integrations/outbound/outbound-url.guard';
import { AuthProviderService } from './auth-provider.service';
import { buildLdapOptions } from './federation.config';
import { getProviderGroupKey, readProviderGroups } from './group-sync.util';
import { readLdapIdentity } from './federated-identity';

@Injectable()
export class LdapService {
  constructor(
    private readonly providers: AuthProviderService,
    private readonly encryption: EncryptionService,
    private readonly auth: AuthService,
    private readonly environment: EnvironmentService,
    private readonly outbound: OutboundUrlGuard,
  ) {}

  async login(
    workspaceId: string,
    providerId: string,
    username: string,
    password: string,
  ) {
    const provider = await this.providers.findEnabled(workspaceId, providerId);
    if (provider.type !== 'ldap')
      throw new BadRequestException('Provider is not LDAP.');
    const options = buildLdapOptions(
      {
        ...provider,
        ldapTlsCaCert: provider.ldapTlsCaCert
          ? this.encryption.decrypt(provider.ldapTlsCaCert)
          : null,
      },
      username,
    );
    const pinned = await this.outbound.validate(this.asHttpsUrl(options.url), {
      requireHttps: true,
      privateHostnames: this.environment.getLdapPrivateHosts(),
      allowPrivateNetworks: false,
      port: this.ldapPort(options.url),
    });
    const client = new Client({
      url: this.pinUrl(options.url, pinned.address),
      timeout: options.timeout,
      connectTimeout: options.connectTimeout,
      tlsOptions: { ...options.tlsOptions, servername: pinned.hostname },
    });
    try {
      if (!provider.ldapBindDn || !provider.ldapBindPassword) {
        throw new BadRequestException('LDAP service credentials are required.');
      }
      await client.bind(
        provider.ldapBindDn,
        this.encryption.decrypt(provider.ldapBindPassword),
      );
      const groupAttribute = getProviderGroupKey(provider, 'groupAttribute');
      const identityAttributes = Object.values(
        (provider.ldapUserAttributes as Record<string, unknown> | null) ?? {},
      ).filter((value): value is string => typeof value === 'string');
      const { searchEntries } = await client.search(options.baseDn, {
        scope: 'sub',
        filter: options.filter,
        attributes: [
          ...new Set([groupAttribute, ...identityAttributes].filter(Boolean)),
        ],
      });
      if (searchEntries.length !== 1)
        throw new UnauthorizedException('Invalid LDAP credentials.');
      const entry = searchEntries[0];
      await client.bind(entry.dn, password);
      const subject = String(entry.objectName || entry.dn);
      const identity = readLdapIdentity(
        subject,
        entry as Record<string, unknown>,
        provider.ldapUserAttributes,
      );
      identity.groups = readProviderGroups(
        provider,
        entry as Record<string, unknown>,
        'groupAttribute',
      );
      return this.auth.loginFederated(provider.id, identity, workspaceId);
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  private asHttpsUrl(ldapUrl: string): string {
    const url = new URL(ldapUrl);
    // URL protocol assignment cannot switch LDAPS to a special HTTPS scheme.
    return `https:${url.href.slice(url.protocol.length)}`;
  }

  private ldapPort(ldapUrl: string): number {
    return Number(new URL(ldapUrl).port || 636);
  }

  private pinUrl(ldapUrl: string, address: string): string {
    const url = new URL(ldapUrl);
    url.hostname = address.includes(':') ? `[${address}]` : address;
    return url.toString();
  }
}
