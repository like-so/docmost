import { BadRequestException } from '@nestjs/common';
import { ShareController } from './share.controller';

describe('ShareController', () => {
  it('excludes a restricted page from public sharing after edit authorization', async () => {
    const page = { id: 'page', workspaceId: 'workspace', spaceId: 'space' };
    const pageAccess = { validateCanEdit: jest.fn().mockResolvedValue(undefined) };
    const permissions = { hasRestrictedAncestor: jest.fn().mockResolvedValue(true) };
    const shares = { createShare: jest.fn(), isSharingAllowed: jest.fn() };
    const controller = new ShareController(
      shares as any,
      {} as any,
      { findById: jest.fn().mockResolvedValue(page) } as any,
      permissions as any,
      pageAccess as any,
      { log: jest.fn() } as any,
    );

    await expect(
      controller.create({ pageId: 'page' } as any, { id: 'user' } as any, {
        id: 'workspace',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(shares.createShare).not.toHaveBeenCalled();
  });
});

describe('Base public sharing', () => {
  it('rejects public sharing for bases before creating a share', async () => {
    const shares = { createShare: jest.fn(), isSharingAllowed: jest.fn() };
    const controller = new ShareController(
      shares as any,
      {} as any,
      { findById: jest.fn().mockResolvedValue({ id: 'base', workspaceId: 'workspace', spaceId: 'space', isBase: true }) } as any,
      {} as any,
      { validateCanEdit: jest.fn() } as any,
      { log: jest.fn() } as any,
    );
    await expect(controller.create({ pageId: 'base' } as any, { id: 'user' } as any, { id: 'workspace' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(shares.createShare).not.toHaveBeenCalled();
  });
});
