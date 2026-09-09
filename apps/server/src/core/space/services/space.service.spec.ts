import { ForbiddenException } from '@nestjs/common';
import { SpaceService } from './space.service';

describe('SpaceService security settings', () => {
  it('does not persist public-sharing or viewer-comment settings when disabled by deployment capability', async () => {
    const spaceRepo = {
      updateSharingSettings: jest.fn(),
      updateCommentSettings: jest.fn(),
    };
    const service = new SpaceService(
      spaceRepo as any,
      {} as any,
      { deleteBySpaceId: jest.fn() } as any,
      { isSecurityControlsEnabled: () => false } as any,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
    );

    await expect(
      service.updateSpace(
        {
          spaceId: 'space',
          disablePublicSharing: true,
          allowViewerComments: true,
        },
        'workspace',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(spaceRepo.updateSharingSettings).not.toHaveBeenCalled();
    expect(spaceRepo.updateCommentSettings).not.toHaveBeenCalled();
  });
});
