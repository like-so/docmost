import { ScimController } from './scim.controller';

describe('ScimController groups', () => {
  const resources = {
    listGroups: jest.fn(),
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
