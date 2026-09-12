import { SpaceController } from './space.controller';

describe('SpaceController personal-space navigation', () => {
  const members = { getUserSpaces: jest.fn() };
  const roles = { getUserRolesForSpaces: jest.fn() };
  const controller = new SpaceController(
    {} as any,
    members as any,
    roles as any,
    {} as any,
    {} as any,
  );
  const user = { id: 'user' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getUserRolesForSpaces.mockResolvedValue([]);
    members.getUserSpaces.mockResolvedValue({
      items: [
        { id: 'team', isPersonal: false },
        { id: 'personal', isPersonal: true },
      ],
    });
  });

  it('hides existing personal spaces from navigation when disabled', async () => {
    const result = await controller.getWorkspaceSpaces(
      {} as any,
      user,
      { settings: { spaces: { allowPersonal: false } } } as any,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('team');
    expect(roles.getUserRolesForSpaces).toHaveBeenCalledWith(user.id, ['team']);
  });

  it('shows existing personal spaces again when enabled', async () => {
    const result = await controller.getWorkspaceSpaces(
      {} as any,
      user,
      { settings: { spaces: { allowPersonal: true } } } as any,
    );

    expect(result.items.map((space) => space.id)).toEqual(['team', 'personal']);
  });
});
