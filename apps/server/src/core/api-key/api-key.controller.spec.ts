import { ApiKeyController } from './api-key.controller';

describe('ApiKeyController', () => {
  const user = { id: 'user', workspaceId: 'workspace' } as any;
  const service = {
    list: jest.fn(),
    create: jest.fn(),
    rename: jest.fn(),
    revoke: jest.fn(),
    listWorkspace: jest.fn(),
    renameWorkspace: jest.fn(),
    revokeWorkspace: jest.fn(),
  };
  const controller = new ApiKeyController(service as any);

  beforeEach(() => jest.clearAllMocks());

  it('uses ownership-scoped endpoints for personal keys', async () => {
    await controller.list(user);
    await controller.create(user, {
      name: 'personal',
      scopes: ['read'],
      expiresAt: undefined,
    });
    await controller.rename(user, 'key', { name: 'renamed' });
    await controller.revoke(user, 'key');
    expect(service.list).toHaveBeenCalledWith(user);
    expect(service.create).toHaveBeenCalledWith(
      user,
      'personal',
      ['read'],
      undefined,
    );
    expect(service.rename).toHaveBeenCalledWith(user, 'key', 'renamed');
    expect(service.revoke).toHaveBeenCalledWith(user, 'key');
  });

  it('uses distinct workspace management methods', async () => {
    await controller.listWorkspace(user);
    await controller.renameWorkspace(user, 'key', { name: 'renamed' });
    await controller.revokeWorkspace(user, 'key');
    expect(service.listWorkspace).toHaveBeenCalledWith(user);
    expect(service.renameWorkspace).toHaveBeenCalledWith(
      user,
      'key',
      'renamed',
    );
    expect(service.revokeWorkspace).toHaveBeenCalledWith(user, 'key');
  });
});
