import { ScimController } from './scim.controller';

describe('ScimController groups', () => {
  const resources = {
    listUsers: jest.fn(),
    listGroups: jest.fn(),
    patchUser: jest.fn(),
    patchGroup: jest.fn(),
    replaceGroup: jest.fn(),
  };
  const controller = new ScimController(resources as any);

  beforeEach(() => jest.clearAllMocks());

  it('uses the authenticated workspace for paginated group lists', () => {
    controller.groups({ scimWorkspaceId: 'workspace-a' }, '3', '1');
    expect(resources.listGroups).toHaveBeenCalledWith('workspace-a', 3, 1);
  });

  it('forwards documented group filters to the workspace-scoped resource service', () => {
    controller.groups(
      { scimWorkspaceId: 'workspace-a' },
      '1',
      '100',
      'displayName eq "Engineering"',
    );
    expect(resources.listGroups).toHaveBeenCalledWith(
      'workspace-a',
      1,
      100,
      'displayName eq "Engineering"',
    );
  });

  it('forwards an explicit zero count without replacing it with the default', () => {
    controller.users({ scimWorkspaceId: 'workspace-a' }, '1', '0');
    controller.groups({ scimWorkspaceId: 'workspace-a' }, '1', '0');

    expect(resources.listUsers).toHaveBeenCalledWith(
      'workspace-a',
      1,
      0,
      undefined,
    );
    expect(resources.listGroups).toHaveBeenCalledWith('workspace-a', 1, 0);
  });

  it('addresses replacement by internal group ID in the authenticated workspace', () => {
    const input = {
      displayName: 'Engineering',
      externalId: 'eng',
      members: [],
    };
    controller.replaceGroup(
      { scimWorkspaceId: 'workspace-a' },
      'group-id',
      input,
    );
    expect(resources.replaceGroup).toHaveBeenCalledWith(
      'workspace-a',
      'group-id',
      input,
    );
  });
});
