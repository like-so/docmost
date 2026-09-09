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

@Controller('security/providers')
export class AuthProviderController {
  constructor(
    private readonly providerService: AuthProviderService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly capability: SsoCapabilityService,
  ) {}

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
  list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    return this.providerService.list(workspace.id);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('create')
  create(
    @Body() dto: CreateAuthProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    return this.providerService.create(workspace.id, user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('update')
  update(
    @Body() dto: UpdateAuthProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.capability.assertEnabled();
    this.requireSettingsAccess(user, workspace);
    const { id, ...update } = dto;
    return this.providerService.update(workspace.id, user, id, update);
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

  private requireSettingsAccess(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }
}
