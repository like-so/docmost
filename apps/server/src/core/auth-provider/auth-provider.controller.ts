import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { AuthProviderService } from './auth-provider.service';
import { CreateAuthProviderDto } from './dto/create-auth-provider.dto';
import { UpdateAuthProviderDto } from './dto/update-auth-provider.dto';
import { SsoCapabilityService } from './sso-capability.service';
import { randomUUID } from 'node:crypto';
import { DomainService } from '../../integrations/environment/domain.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { buildCallbackUrl, buildSamlUrls } from './callback-url.util';

@Controller('security/providers')
export class AuthProviderController {
  constructor(
    private readonly providerService: AuthProviderService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly capability: SsoCapabilityService,
    private readonly domain: DomainService,
    private readonly environment: EnvironmentService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('prepare')
  prepare(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    const id = randomUUID();
    return { id, connectionInfo: this.connectionInfo(workspace, id) };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('enabled')
  enabled(@AuthWorkspace() workspace: Workspace) {
    this.capability.assertEnabled();
    return this.providerService.listEnabled(workspace.id);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('list')
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    return (await this.providerService.list(workspace.id)).map((provider) => ({
      ...provider,
      connectionInfo: this.connectionInfo(workspace, provider.id),
    }));
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateAuthProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    const provider = await this.providerService.create(workspace.id, user, dto);
    return { ...provider, connectionInfo: this.connectionInfo(workspace, provider.id) };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateAuthProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    const { id, ...update } = dto;
    const provider = await this.providerService.update(workspace.id, user, id, update);
    return { ...provider, connectionInfo: this.connectionInfo(workspace, provider.id) };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(
    @Body() dto: UpdateAuthProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    await this.providerService.remove(workspace.id, user, dto.id);
  }

  private connectionInfo(workspace: Workspace, providerId: string) {
    const appUrl = this.domain.getUrl(workspace.hostname);
    const cloud = this.environment.isCloud();
    const subdomainHost = this.environment.getSubdomainHost();
    const saml = buildSamlUrls(appUrl, cloud, subdomainHost, workspace.hostname, providerId);
    return {
      oidcCallbackUrl: buildCallbackUrl(appUrl, cloud, subdomainHost, workspace.hostname, providerId),
      samlEntityId: saml.entityId,
      samlAcsUrl: saml.callbackUrl,
    };
  }

  private requireSettingsAccess(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }
}
