import { getProviderGroupKey, readProviderGroups } from './group-sync.util';

describe('provider group claims', () => {
  const provider = {
    groupSync: true,
    type: 'oidc',
    settings: { groupClaim: 'memberOf' },
  } as any;

  it('normalizes arrays and documented delimiter-separated values case-insensitively', () => {
    expect(
      readProviderGroups(provider, {
        memberOf: ['ops', ' Ops ; finance, HR ', 3, ''],
      }),
    ).toEqual(['ops', 'finance', 'hr']);
  });

  it('uses documented OIDC aliases when groupClaim is absent', () => {
    expect(
      readProviderGroups(
        { groupSync: true, type: 'oidc', settings: {} } as any,
        { roles: ['Engineering'] },
      ),
    ).toEqual(['engineering']);
  });

  it('uses documented SAML aliases including URI claims', () => {
    expect(
      readProviderGroups(
        { groupSync: true, type: 'saml', settings: {} } as any,
        {
          'http://schemas.microsoft.com/ws/2008/06/identity/claims/role':
            'Admin; Readers',
        },
      ),
    ).toEqual(['admin', 'readers']);
  });

  it('reads LDAP configured attributes and normalizes DN common names', () => {
    const ldap = {
      groupSync: true,
      type: 'ldap',
      settings: { groupAttribute: 'memberOf' },
    } as any;
    expect(getProviderGroupKey(ldap, 'groupAttribute')).toBe('memberOf');
    expect(
      readProviderGroups(
        ldap,
        { memberOf: ['CN=Ops,OU=Groups,DC=example,DC=com'] },
        'groupAttribute',
      ),
    ).toEqual(['ops']);
  });

  it('returns no memberships for disabled sync or invalid claims', () => {
    expect(
      readProviderGroups(
        { ...provider, groupSync: false },
        { memberOf: ['ops'] },
      ),
    ).toBeUndefined();
    expect(readProviderGroups(provider, { memberOf: 4 })).toBeUndefined();
  });
});
