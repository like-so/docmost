import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { PageService } from '../page/services/page.service';
import { PageAccessService } from '../page/page-access/page-access.service';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { User } from '@docmost/db/types/entity.types';
import {
  CreateTemplateDto,
  InstantiateTemplateDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepo: TemplateRepo,
    private readonly pageService: PageService,
    private readonly pageAccess: PageAccessService,
    private readonly spaceMembers: SpaceMemberRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async list(user: User, workspaceId: string, pagination: any) {
    return this.templateRepo.findTemplates(
      workspaceId,
      await this.spaceMembers.getUserSpaceIds(user.id),
      pagination,
      { spaceId: pagination.spaceId },
    );
  }

  async create(user: User, workspaceId: string, dto: CreateTemplateDto) {
    await this.assertCanCreate(user, workspaceId, dto.spaceId);
    const template = await this.templateRepo.insertTemplate({
      title: dto.title,
      description: dto.description,
      icon: dto.icon,
      content: dto.content,
      workspaceId,
      spaceId: dto.spaceId ?? null,
      creatorId: user.id,
      lastUpdatedById: user.id,
    });
    await this.auditService.log({
      event: AuditEvent.TEMPLATE_CREATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: template.id,
      spaceId: template.spaceId,
      changes: { after: { title: template.title } },
    });
    return template;
  }

  async update(user: User, workspaceId: string, dto: UpdateTemplateDto) {
    const template = await this.getEditable(user, workspaceId, dto.templateId);
    await this.assertCanCreate(
      user,
      workspaceId,
      dto.spaceId ?? template.spaceId,
    );
    await this.templateRepo.updateTemplate(
      {
        title: dto.title,
        description: dto.description,
        icon: dto.icon,
        content: dto.content,
        spaceId: dto.spaceId ?? template.spaceId,
        lastUpdatedById: user.id,
      },
      dto.templateId,
      workspaceId,
    );
    await this.auditService.log({
      event: AuditEvent.TEMPLATE_UPDATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: dto.templateId,
      spaceId: dto.spaceId ?? template.spaceId,
      changes: { before: { title: template.title }, after: { title: dto.title } },
    });
  }

  async remove(user: User, workspaceId: string, templateId: string) {
    await this.getEditable(user, workspaceId, templateId);
    await this.templateRepo.deleteTemplate(templateId, workspaceId);
    await this.auditService.log({
      event: AuditEvent.TEMPLATE_DELETED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: templateId,
    });
  }

  async instantiate(
    user: User,
    workspaceId: string,
    dto: InstantiateTemplateDto,
  ) {
    const template = await this.templateRepo.findById(
      dto.templateId,
      workspaceId,
      { includeContent: true },
    );
    if (!template) throw new NotFoundException('Template not found');
    if (
      template.spaceId &&
      !(await this.spaceMembers.getUserSpaceIds(user.id)).includes(
        template.spaceId,
      )
    )
      throw new ForbiddenException();
    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page))
      throw new ForbiddenException();
    const page = dto.parentPageId
      ? await this.pageService.findById(dto.parentPageId)
      : undefined;
    if (dto.parentPageId && (!page || page.spaceId !== dto.spaceId))
      throw new NotFoundException('Parent page not found');
    if (page) await this.pageAccess.validateCanEdit(page, user);
    return this.pageService.create(user.id, workspaceId, {
      title: template.title ?? 'Untitled',
      icon: template.icon ?? undefined,
      content: template.content as object,
      format: 'json',
      spaceId: dto.spaceId,
      parentPageId: dto.parentPageId,
    });
  }

  private async getEditable(
    user: User,
    workspaceId: string,
    templateId: string,
  ) {
    const template = await this.templateRepo.findById(templateId, workspaceId);
    if (!template) throw new NotFoundException('Template not found');
    if (
      template.creatorId !== user.id &&
      user.role !== 'owner' &&
      user.role !== 'admin'
    )
      throw new ForbiddenException();
    return template;
  }

  private async assertCanCreate(
    user: User,
    workspaceId: string,
    spaceId?: string | null,
  ) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const settings = workspace?.settings as Record<string, any> | null;
    if (user.role === 'member' && !settings?.templates?.allowMemberTemplates)
      throw new ForbiddenException('Member templates are disabled');
    if (
      spaceId &&
      !(await this.spaceMembers.getUserSpaceIds(user.id)).includes(spaceId)
    )
      throw new ForbiddenException();
    if (spaceId) {
      const ability = await this.spaceAbility.createForUser(user, spaceId);
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page))
        throw new ForbiddenException();
    }
  }
}
