import { ForbiddenException } from '@nestjs/common';
import { TemplateService } from './template.service';

describe('TemplateService', () => {
  const user = { id: 'user', role: 'member' } as any;
  const workspace = { findById: jest.fn() };
  const templateRepo = { insertTemplate: jest.fn(), findTemplates: jest.fn() };
  const spaceMembers = { getUserSpaceIds: jest.fn().mockResolvedValue([]) };
  const spaceAbility = { createForUser: jest.fn() };
  const service = new TemplateService(
    templateRepo as any,
    {} as any,
    {} as any,
    spaceMembers as any,
    workspace as any,
    spaceAbility as any,
    { log: jest.fn() } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    spaceMembers.getUserSpaceIds.mockResolvedValue([]);
    templateRepo.insertTemplate.mockResolvedValue({
      id: 'template',
      title: 'Template',
      description: 'Description',
      spaceId: null,
    });
  });

  it('denies member creation when the workspace policy is disabled', async () => {
    workspace.findById.mockResolvedValue({
      settings: { templates: { allowMemberTemplates: false } },
    });
    await expect(
      service.create(user, 'workspace', { title: 'Template' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(templateRepo.insertTemplate).not.toHaveBeenCalled();
  });

  it('persists member templates only when the workspace policy allows them', async () => {
    workspace.findById.mockResolvedValue({
      settings: { templates: { allowMemberTemplates: true } },
    });
    await service.create(user, 'workspace', { title: 'Template' });
    expect(templateRepo.insertTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace', creatorId: 'user' }),
    );
    expect((service as any).auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template.created',
        spaceId: null,
        changes: { after: { title: 'Template' } },
      }),
    );
  });

  it('denies readers and permits editors to create scoped templates', async () => {
    workspace.findById.mockResolvedValue({
      settings: { templates: { allowMemberTemplates: true } },
    });
    spaceMembers.getUserSpaceIds.mockResolvedValue(['space']);
    spaceAbility.createForUser.mockResolvedValue({
      cannot: jest.fn().mockReturnValue(true),
    });
    await expect(
      service.create(user, 'workspace', {
        title: 'Template',
        spaceId: 'space',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    spaceAbility.createForUser.mockResolvedValue({
      cannot: jest.fn().mockReturnValue(false),
    });
    await expect(
      service.create(user, 'workspace', {
        title: 'Template',
        spaceId: 'space',
      }),
    ).resolves.toEqual({
      id: 'template',
      title: 'Template',
      description: 'Description',
      spaceId: null,
    });
  });
});
