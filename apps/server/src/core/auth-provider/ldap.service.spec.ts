const mockBind = jest.fn();
const mockSearch = jest.fn();
const mockUnbind = jest.fn();
const mockClient = jest.fn().mockImplementation(() => ({
  bind: mockBind,
  search: mockSearch,
  unbind: mockUnbind,
}));

jest.mock('ldapts', () => ({ Client: mockClient }));

import { LdapService } from './ldap.service';

describe('LdapService TLS configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBind.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue({
      searchEntries: [
        {
          dn: 'cn=user',
          objectName: 'subject-id',
          mail: 'person@example.com',
          displayName: 'Person',
          mailVerified: 'true',
        },
      ],
    });
    mockUnbind.mockResolvedValue(undefined);
  });

  it('decrypts the stored CA certificate only before building TLS options', async () => {
    const provider = {
      id: 'provider-id',
      type: 'ldap',
      ldapUrl: 'ldaps://directory.example',
      ldapBaseDn: 'dc=example',
      ldapBindDn: 'cn=service',
      ldapBindPassword: 'encrypted:bind-password',
      ldapTlsCaCert: 'encrypted:ca-certificate',
      ldapUserSearchFilter: '(uid={username})',
      ldapUserAttributes: {
        email: 'mail',
        name: 'displayName',
        emailVerified: 'mailVerified',
      },
      groupSync: false,
    };
    const encryption = {
      decrypt: jest.fn((value) => value.replace('encrypted:', 'plain:')),
    };
    const auth = {
      loginFederated: jest.fn().mockResolvedValue({ authToken: 'token' }),
    };
    const outbound = {
      validate: jest.fn().mockResolvedValue({
        hostname: 'directory.example',
        address: '93.184.216.34',
        family: 4,
      }),
    };
    const service = new LdapService(
      { findEnabled: jest.fn().mockResolvedValue(provider) } as any,
      encryption as any,
      auth as any,
      { getLdapPrivateHosts: jest.fn().mockReturnValue(['directory.internal']) } as any,
      outbound as any,
    );

    await service.login('workspace-id', provider.id, 'user', 'password');

    expect(encryption.decrypt).toHaveBeenCalledWith('encrypted:ca-certificate');
    expect(outbound.validate).toHaveBeenCalledWith('ldaps://directory.example', {
      requireHttps: true,
      privateHostnames: ['directory.internal'],
      allowPrivateNetworks: false,
      port: 636,
    });
    expect(mockClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'ldaps://93.184.216.34',
        tlsOptions: {
          ca: ['plain:ca-certificate'],
          servername: 'directory.example',
        },
      }),
    );
    expect(auth.loginFederated).toHaveBeenCalledWith(
      provider.id,
      expect.objectContaining({
        subject: 'subject-id',
        email: 'person@example.com',
        emailVerified: true,
        name: 'Person',
      }),
      'workspace-id',
    );
  });

  it('does not create an LDAP connection when destination validation rejects it', async () => {
    const provider = {
      id: 'provider-id',
      type: 'ldap',
      ldapUrl: 'ldaps://169.254.169.254',
      ldapBaseDn: 'dc=example',
    };
    const service = new LdapService(
      { findEnabled: jest.fn().mockResolvedValue(provider) } as any,
      { decrypt: jest.fn() } as any,
      { loginFederated: jest.fn() } as any,
      { getLdapPrivateHosts: jest.fn().mockReturnValue([]) } as any,
      { validate: jest.fn().mockRejectedValue(new Error('blocked')) } as any,
    );

    await expect(
      service.login('workspace-id', provider.id, 'user', 'password'),
    ).rejects.toThrow('blocked');
    expect(mockClient).not.toHaveBeenCalled();
  });
});
