import { ForbiddenException } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';

describe('WorkspaceService security controls', () => {
  it('does not persist workspace controls when the deployment capability is disabled', async () => {
    const workspaceRepo = { updateSharingSettings: jest.fn() };
    const service = new WorkspaceService(
      workspaceRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { isSecurityControlsEnabled: () => false } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.update('workspace', { disablePublicSharing: true } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(workspaceRepo.updateSharingSettings).not.toHaveBeenCalled();
  });
});
