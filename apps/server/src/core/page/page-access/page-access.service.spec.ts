import { ForbiddenException } from '@nestjs/common';
import { PageAccessService } from './page-access.service';

describe('PageAccessService', () => {
  const page = { id: 'page', spaceId: 'space' } as any;
  const user = { id: 'user' } as any;

  function createService(overrides: Record<string, any> = {}) {
    const permissions = {
      canUserAccessPage: jest.fn().mockResolvedValue(true),
      canUserEditPage: jest.fn().mockResolvedValue({
        hasAnyRestriction: true,
        canAccess: true,
        canEdit: false,
      }),
    };
    const ability = {
      createForUser: jest.fn().mockResolvedValue({
        cannot: () => false,
        can: () => false,
      }),
    };
    const spaces = { findById: jest.fn().mockResolvedValue({ settings: {} }) };
    return {
      service: new PageAccessService(permissions as any, ability as any, spaces as any),
      permissions,
      ability,
      spaces,
      ...overrides,
    };
  }

  it('denies restricted content when the member has no effective grant', async () => {
    const context = createService();
    context.permissions.canUserAccessPage.mockResolvedValue(false);

    await expect(context.service.validateCanView(page, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('does not let a reader comment unless the space enables viewer comments', async () => {
    const context = createService();

    await expect(
      context.service.validateCanComment(page, user, 'workspace'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    context.spaces.findById.mockResolvedValue({
      settings: { comments: { allowViewerComments: true } },
    });
    await expect(
      context.service.validateCanComment(page, user, 'workspace'),
    ).resolves.toBeUndefined();
  });
});
