import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthProvider } from '@docmost/db/types/entity.types';
import { AuthService } from '../src/core/auth/services/auth.service';
import { AuthProviderService } from '../src/core/auth-provider/auth-provider.service';
import { buildLdapFilter } from '../src/core/auth-provider/federation.util';
import { FederatedIdentity } from '../src/core/auth-provider/federated-identity';
import { LdapService } from '../src/core/auth-provider/ldap.service';
import { EncryptionService } from '../src/integrations/encryption/encryption.service';
import { EnvironmentService } from '../src/integrations/environment/environment.service';
import { OutboundUrlGuard } from '../src/integrations/outbound/outbound-url.guard';

type LoginResult = { authToken: string };

type LdapInput = {
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  caCert: string;
  email: string;
  emailAttribute: string;
  groups: string[];
  groupAttribute: string;
  name: string;
  nameAttribute: string;
  password: string;
  subject: string;
  url: string;
  username: string;
  verifiedAttribute: string;
};

let input: LdapInput;
let service: LdapService;
let auth: AuthPort;
let workspaceId: string;
let providerId: string;

beforeAll(() => {
  input = readInput();
  workspaceId = randomUUID();
  providerId = randomUUID();
  auth = new AuthPort();
  service = createService(input, auth, workspaceId, providerId);
});

describe('LdapService issue-owned LDAPS interoperability', () => {
  it('binds, searches, user-binds, and maps verified profile and group claims', async () => {
    await expect(
      service.login(workspaceId, providerId, input.username, input.password),
    ).resolves.toEqual({ authToken: 'issue-owned-ldap-login' });

    expect(auth.identity).toEqual({
      email: input.email,
      emailVerified: true,
      groups: input.groups,
      name: input.name,
      subject: input.subject,
    });
    expect(auth.providerId).toBe(providerId);
    expect(auth.workspaceId).toBe(workspaceId);
  });

  it('escapes the documented username placeholder before LDAP filter use', () => {
    expect(buildLdapFilter('(uid={{username}})', 'user*(admin)\\')).toBe(
      '(uid=user\\2a\\28admin\\29\\5c)',
    );
  });

  it('rejects a disabled provider before attempting LDAP login', async () => {
    const disabled = createDisabledService(input, auth, workspaceId, providerId);

    await expect(
      disabled.login(workspaceId, providerId, input.username, input.password),
    ).rejects.toThrow('LDAP provider is disabled.');
  });
});

function createService(
  values: LdapInput,
  login: AuthPort,
  workspace: string,
  provider: string,
): LdapService {
  const environment = environmentFor(values.url);
  const encryption = new EncryptionService(environment);
  const providerPort = new ProviderPort(
    createProvider(values, encryption, workspace, provider),
  );
  return new LdapService(
    providerPort as unknown as AuthProviderService,
    encryption,
    login as unknown as AuthService,
    environment,
    new OutboundUrlGuard(environment),
  );
}

function createDisabledService(
  values: LdapInput,
  login: AuthPort,
  workspace: string,
  provider: string,
): LdapService {
  const environment = environmentFor(values.url);
  const encryption = new EncryptionService(environment);
  return new LdapService(
    new DisabledProviderPort() as unknown as AuthProviderService,
    encryption,
    login as unknown as AuthService,
    environment,
    new OutboundUrlGuard(environment),
  );
}

function createProvider(
  values: LdapInput,
  encryption: EncryptionService,
  workspaceId: string,
  id: string,
): AuthProvider {
  return {
    allowSignup: false,
    createdAt: new Date(),
    creatorId: null,
    deletedAt: null,
    groupSync: true,
    id,
    isEnabled: true,
    ldapBaseDn: values.baseDn,
    ldapBindDn: values.bindDn,
    ldapBindPassword: encryption.encrypt(values.bindPassword),
    ldapConfig: null,
    ldapTlsCaCert: encryption.encrypt(values.caCert),
    ldapTlsEnabled: true,
    ldapUrl: values.url,
    ldapUserAttributes: {
      email: values.emailAttribute,
      emailVerified: values.verifiedAttribute,
      name: values.nameAttribute,
    },
    ldapUserSearchFilter: '(uid={{username}})',
    name: 'LIKE-157 issue-owned LDAPS provider',
    oidcClientId: null,
    oidcClientSecret: null,
    oidcIssuer: null,
    samlCertificate: null,
    samlEntityId: null,
    samlUrl: null,
    settings: { groupAttribute: values.groupAttribute },
    type: 'ldap',
    updatedAt: new Date(),
    workspaceId,
  };
}

function environmentFor(ldapUrl: string): EnvironmentService {
  const hostname = new URL(ldapUrl).hostname;
  const values: Record<string, string> = {
    APP_SECRET: randomUUID(),
    CLOUD: 'false',
    LDAP_PRIVATE_HOSTS: hostname,
  };
  const config = {
    get<T>(key: string, fallback?: T): T {
      return (values[key] ?? fallback) as T;
    },
  };
  return new EnvironmentService(config as unknown as ConfigService);
}

function readInput(): LdapInput {
  const url = requireInput('LIKE157_LDAP_URL');
  if (new URL(url).protocol !== 'ldaps:') {
    throw new Error('LIKE157_LDAP_URL must use ldaps:.');
  }
  return {
    baseDn: requireInput('LIKE157_LDAP_BASE_DN'),
    bindDn: requireInput('LIKE157_LDAP_BIND_DN'),
    bindPassword: requireInput('LIKE157_LDAP_BIND_PASSWORD'),
    caCert: requireInput('LIKE157_LDAP_CA_CERT'),
    email: requireInput('LIKE157_LDAP_EXPECTED_EMAIL'),
    emailAttribute: requireInput('LIKE157_LDAP_EMAIL_ATTRIBUTE'),
    groups: requireInput('LIKE157_LDAP_EXPECTED_GROUPS')
      .split(',')
      .map((group) => group.trim().toLocaleLowerCase())
      .filter(Boolean),
    groupAttribute: requireInput('LIKE157_LDAP_GROUP_ATTRIBUTE'),
    name: requireInput('LIKE157_LDAP_EXPECTED_NAME'),
    nameAttribute: requireInput('LIKE157_LDAP_NAME_ATTRIBUTE'),
    password: requireInput('LIKE157_LDAP_PASSWORD'),
    subject: requireInput('LIKE157_LDAP_EXPECTED_SUBJECT'),
    url,
    username: requireInput('LIKE157_LDAP_USERNAME'),
    verifiedAttribute: requireInput('LIKE157_LDAP_VERIFIED_ATTRIBUTE'),
  };
}

function requireInput(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the LDAPS e2e spec.`);
  return value;
}

class ProviderPort {
  constructor(private readonly provider: AuthProvider) {}

  async findEnabled(workspaceId: string, providerId: string): Promise<AuthProvider> {
    if (workspaceId !== this.provider.workspaceId || providerId !== this.provider.id) {
      throw new UnauthorizedException('LDAP provider is unavailable.');
    }
    return this.provider;
  }
}

class DisabledProviderPort {
  async findEnabled(): Promise<never> {
    throw new UnauthorizedException('LDAP provider is disabled.');
  }
}

class AuthPort {
  identity?: FederatedIdentity;
  providerId?: string;
  workspaceId?: string;

  async loginFederated(
    providerId: string,
    identity: FederatedIdentity,
    workspaceId: string,
  ): Promise<LoginResult> {
    this.identity = identity;
    this.providerId = providerId;
    this.workspaceId = workspaceId;
    return { authToken: 'issue-owned-ldap-login' };
  }
}
