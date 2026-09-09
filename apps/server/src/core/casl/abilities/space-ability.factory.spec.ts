import { NotFoundException } from '@nestjs/common';
import SpaceAbilityFactory from './space-ability.factory';

describe('SpaceAbilityFactory personal-space policy', () => {
  const members = { getUserSpaceRoles: jest.fn() };
  const spaces = { findById: jest.fn() };
  const workspaces = { findById: jest.fn() };
  const factory = new SpaceAbilityFactory(
    members as any,
    spaces as any,
    workspaces as any,
  );
  const user = { id: 'user', workspaceId: 'workspace' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    spaces.findById.mockResolvedValue({ id: 'space', isPersonal: true });
    workspaces.findById.mockResolvedValue({
      settings: { spaces: { allowPersonal: true } },
    });
    members.getUserSpaceRoles.mockResolvedValue([{ role: 'admin' }]);
  });

  it('denies content access to an existing personal space after disablement', async () => {
    workspaces.findById.mockResolvedValue({
      settings: { spaces: { allowPersonal: false } },
    });

    await expect(factory.createForUser(user, 'space')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(members.getUserSpaceRoles).not.toHaveBeenCalled();
  });

  it('restores access when the workspace enables personal spaces again', async () => {
    await expect(factory.createForUser(user, 'space')).resolves.toBeDefined();
  });
});
