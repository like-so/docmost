import { ForbiddenException } from '@nestjs/common';
import { PersonalSpaceService } from './personal-space.service';

describe('PersonalSpaceService', () => {
  const spaces = { findPersonalSpace: jest.fn() };
  const spaceService = { createSpace: jest.fn() };
  const workspaces = { findById: jest.fn() };
  const service = new PersonalSpaceService(
    spaces as any,
    spaceService as any,
    workspaces as any,
  );
  const user = { id: 'user', name: 'User' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    workspaces.findById.mockResolvedValue({
      settings: { spaces: { allowPersonal: true } },
    });
  });

  it('returns an existing personal space instead of creating another', async () => {
    spaces.findPersonalSpace.mockResolvedValue({ id: 'personal' });
    await expect(service.getOrCreate(user, 'workspace')).resolves.toEqual({
      id: 'personal',
    });
    expect(spaceService.createSpace).not.toHaveBeenCalled();
  });

  it('denies personal space access when disabled by workspace policy', async () => {
    workspaces.findById.mockResolvedValue({
      settings: { spaces: { allowPersonal: false } },
    });
    await expect(service.getOrCreate(user, 'workspace')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
