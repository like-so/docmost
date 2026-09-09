import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../common/helpers/types/permission';
import { ScimAdminController } from './scim-admin.controller';

describe('ScimAdminController', () => {
  const tokens = { create: jest.fn(), list: jest.fn(), revoke: jest.fn() };
  const controller = new ScimAdminController(tokens as any);
  const owner = { id: 'owner', role: UserRole.OWNER } as any;
  const member = { id: 'member', role: UserRole.MEMBER } as any;
  const workspace = { id: 'workspace-a' } as any;

  beforeEach(() => jest.clearAllMocks());
  it('creates a plaintext token only for the workspace owner', () => {
    controller.create({ name: 'Directory' }, owner, workspace);
    expect(tokens.create).toHaveBeenCalledWith(
      'Directory',
      'workspace-a',
      'owner',
    );
  });
  it('does not allow non-owners to list or revoke workspace tokens', () => {
    expect(() => controller.list(member, workspace)).toThrow(
      ForbiddenException,
    );
    expect(() => controller.revoke('token-id', member, workspace)).toThrow(
      ForbiddenException,
    );
  });
});
