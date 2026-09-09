jest.mock('@docmost/db/utils', () => ({
  executeTx: jest.fn(async (db, callback) => callback(db)),
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PagePermissionService } from './page-permission.service';

describe('PagePermissionService', () => {
  const user = { id: 'actor' } as any;
  const page = {
    id: 'page',
    workspaceId: 'workspace',
    spaceId: 'space',
    deletedAt: null,
  } as any;

  function createService(overrides: Record<string, any> = {}) {
    const pageRepo = { findById: jest.fn().mockResolvedValue(page) };
    const pagePermissionRepo = {
      findPageAccessByPageId: jest.fn(),
      findRestrictedAncestor: jest.fn(),
      insertPageAccess: jest.fn().mockResolvedValue({ id: 'access' }),
      deletePageAccess: jest.fn(),
      deletePagePermissions: jest.fn(),
      insertPagePermissions: jest.fn(),
      getPagePermissionsPaginated: jest.fn(),
      invalidatePermissionCache: jest.fn(),
    };
    const userRepo = { findById: jest.fn().mockResolvedValue({ id: 'member' }) };
    const groupRepo = { findById: jest.fn().mockResolvedValue({ id: 'group' }) };
    const spaceAbility = {
      createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
    };
    return {
      service: new PagePermissionService(
        pageRepo as any,
        pagePermissionRepo as any,
        userRepo as any,
        groupRepo as any,
        spaceAbility as any,
        {} as any,
      ),
      pageRepo,
      pagePermissionRepo,
      userRepo,
      groupRepo,
      spaceAbility,
      ...overrides,
    };
  }

  it('rejects a page outside the active workspace before granting access', async () => {
    const context = createService();
    context.pageRepo.findById.mockResolvedValue({ ...page, workspaceId: 'other' });

    await expect(
      context.service.updatePermissions('page', user, 'workspace', false, []),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(context.pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
  });

  it('requires space page management before changing grants', async () => {
    const context = createService();
    context.spaceAbility.createForUser.mockResolvedValue({ cannot: () => true });

    await expect(
      context.service.updatePermissions('page', user, 'workspace', false, []),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects grant members outside the active workspace', async () => {
    const context = createService();
    context.userRepo.findById.mockResolvedValue(undefined);

    await expect(
      context.service.updatePermissions('page', user, 'workspace', false, [
        { userId: 'outside-user', role: 'reader' },
      ]),
    ).rejects.toThrow('Permission member not found');
    expect(context.pagePermissionRepo.deletePagePermissions).not.toHaveBeenCalled();
  });

  it('rejects ambiguous user and group grants', async () => {
    const context = createService();

    await expect(
      context.service.updatePermissions('page', user, 'workspace', false, [
        { userId: 'user', groupId: 'group', role: 'reader' },
      ]),
    ).rejects.toThrow('Each permission must identify one member');
  });

  it('preserves the manager as a writer while applying reader and group grants', async () => {
    const context = createService();

    await context.service.updatePermissions('page', user, 'workspace', false, [
      { userId: 'reader', role: 'reader' },
      { groupId: 'group', role: 'writer' },
    ]);

    expect(context.pagePermissionRepo.insertPagePermissions).toHaveBeenCalledWith(
      [
        expect.objectContaining({ userId: 'reader', role: 'reader' }),
        expect.objectContaining({ groupId: 'group', role: 'writer' }),
        expect.objectContaining({ userId: 'actor', role: 'writer' }),
      ],
      expect.anything(),
    );
  });

  it('removes a direct restriction when inheritance is selected', async () => {
    const context = createService();
    context.pagePermissionRepo.findPageAccessByPageId.mockResolvedValue({ id: 'access' });

    await expect(
      context.service.updatePermissions('page', user, 'workspace', true, []),
    ).resolves.toEqual({ accessLevel: 'inherited' });
    expect(context.pagePermissionRepo.deletePageAccess).toHaveBeenCalledWith('page', expect.anything());
    expect(context.pagePermissionRepo.invalidatePermissionCache).toHaveBeenCalledWith(
      'page',
      'workspace',
    );
  });

  it('does not invalidate permission caches when grant replacement rolls back', async () => {
    const context = createService();
    context.pagePermissionRepo.deletePagePermissions.mockRejectedValue(
      new Error('write failed'),
    );

    await expect(
      context.service.updatePermissions('page', user, 'workspace', false, []),
    ).rejects.toThrow('write failed');
    expect(context.pagePermissionRepo.invalidatePermissionCache).not.toHaveBeenCalled();
  });

});
