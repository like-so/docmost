import { BadRequestException } from '@nestjs/common';
import { AuthProviderService } from './auth-provider.service';

describe('AuthProviderService', () => {
  const workspaceId = 'workspace-id';
  const user = { id: 'user-id' } as any;
  let repo: any;
  let encryption: any;
  let service: AuthProviderService;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      listEnabled: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      linkAccount: jest.fn(),
    };
    encryption = {
      encrypt: jest.fn((value) => `encrypted:${value}`),
      decrypt: jest.fn((value) => value.replace('encrypted:', '')),
    };
    service = new AuthProviderService(repo, encryption, { logWithContext: jest.fn() } as any);
  });

  it('encrypts secrets before creating and redacts them in the response', async () => {
    repo.create.mockResolvedValue({
      id: 'provider-id',
      oidcClientSecret: 'encrypted:secret',
      ldapBindPassword: null,
      ldapTlsCaCert: 'encrypted:ca',
    });

    const result = await service.create(workspaceId, user, {
      name: 'OIDC',
      type: 'oidc',
      oidcIssuer: 'https://issuer.example.com',
      oidcClientId: 'client-id',
      oidcClientSecret: 'secret',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        creatorId: user.id,
        oidcClientSecret: 'encrypted:secret',
      }),
    );
    expect(
      (result as unknown as Record<string, unknown>).oidcClientSecret,
    ).toBeUndefined();
    expect(
      (result as unknown as Record<string, unknown>).ldapTlsCaCert,
    ).toBeUndefined();
  });

  it('keeps omitted encrypted secrets on update', async () => {
    repo.findById.mockResolvedValue({
      id: 'provider-id',
      workspaceId,
      type: 'oidc',
      oidcIssuer: 'https://issuer.example.com',
      oidcClientId: 'client-id',
      oidcClientSecret: 'encrypted:secret',
    });
    repo.update.mockResolvedValue({
      id: 'provider-id',
      oidcClientSecret: 'encrypted:secret',
      ldapBindPassword: null,
      ldapTlsCaCert: null,
    });

    await service.update(workspaceId, user, 'provider-id', { name: 'Renamed' });

    expect(repo.update).toHaveBeenCalledWith(
      'provider-id',
      workspaceId,
      expect.not.objectContaining({ oidcClientSecret: expect.anything() }),
    );
  });

  it('encrypts, redacts, and retains a SAML certificate when omitted on update', async () => {
    repo.create.mockResolvedValue({
      id: 'provider-id',
      type: 'saml',
      samlCertificate: 'encrypted:certificate',
    });
    repo.findById.mockResolvedValue({
      id: 'provider-id',
      workspaceId,
      type: 'saml',
      samlUrl: 'https://idp.example.com/sso',
      samlCertificate: 'encrypted:certificate',
    });
    repo.update.mockResolvedValue({
      id: 'provider-id',
      type: 'saml',
      samlCertificate: 'encrypted:certificate',
    });

    const created = await service.create(workspaceId, user, {
      name: 'SAML',
      type: 'saml',
      samlUrl: 'https://idp.example.com/sso',
      samlCertificate: 'certificate',
    });
    await service.update(workspaceId, user, 'provider-id', { name: 'Renamed' });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ samlCertificate: 'encrypted:certificate' }),
    );
    expect((created as any).samlCertificate).toBeUndefined();
    expect(repo.update).toHaveBeenCalledWith(
      'provider-id',
      workspaceId,
      expect.not.objectContaining({ samlCertificate: expect.anything() }),
    );
  });

  it('only exposes enabled provider metadata publicly', async () => {
    repo.listEnabled.mockResolvedValue([
      { id: 'provider-id', name: 'OIDC', type: 'oidc', isEnabled: true },
    ]);

    await expect(service.listEnabled(workspaceId)).resolves.toEqual([
      { id: 'provider-id', name: 'OIDC', type: 'oidc' },
    ]);
  });

  it('rejects unsupported provider types', async () => {
    await expect(
      service.create(workspaceId, user, {
        name: 'Unknown',
        type: 'unknown' as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists and returns the provider signup setting', async () => {
    repo.create.mockResolvedValue({
      id: 'provider-id',
      type: 'oidc',
      allowSignup: true,
      oidcClientSecret: null,
      ldapBindPassword: null,
      ldapTlsCaCert: null,
    });

    await expect(
      service.create(workspaceId, user, {
        name: 'OIDC',
        type: 'oidc',
        allowSignup: true,
        oidcIssuer: 'https://issuer.example.com',
        oidcClientId: 'client-id',
      }),
    ).resolves.toMatchObject({ allowSignup: true });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ allowSignup: true }),
    );
  });

  it('normalizes allowed domains and rejects malformed domain settings', async () => {
    repo.create.mockResolvedValue({
      id: 'provider-id',
      oidcClientSecret: null,
      ldapBindPassword: null,
      ldapTlsCaCert: null,
    });
    await service.create(workspaceId, user, {
      name: 'OIDC',
      type: 'oidc',
      oidcIssuer: 'https://issuer.example.com',
      oidcClientId: 'client-id',
      settings: { allowedDomains: 'Example.com; @internal.example' },
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { allowedDomains: 'example.com,internal.example' },
      }),
    );
    await expect(
      service.create(workspaceId, user, {
        name: 'OIDC',
        type: 'oidc',
        oidcIssuer: 'https://issuer.example.com',
        oidcClientId: 'client-id',
        settings: { allowedDomains: 'not an email@example.com' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('does not expose an administrative provider-subject linking method', () => {
    expect('linkAccount' in service).toBe(false);
  });
});

describe('AuthProviderService audit trail', () => {
  const workspaceId = 'workspace-id';
  const user = { id: 'user-id' } as any;

  it('records a provider create only after persistence', async () => {
    const repo = { create: jest.fn().mockResolvedValue({ id: 'provider-id' }) };
    const audit = { logWithContext: jest.fn() };
    const service = new AuthProviderService(repo as any, { encrypt: jest.fn() } as any, audit as any);
    await service.create(workspaceId, user, {
      name: 'OIDC', type: 'oidc', oidcIssuer: 'https://issuer.example.com', oidcClientId: 'client',
    });
    expect(audit.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'sso.provider_created', resourceId: 'provider-id' }),
      expect.objectContaining({ workspaceId, actorId: user.id }),
    );
  });
});
