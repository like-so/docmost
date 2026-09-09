import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRole } from '../common/helpers/types/permission';
import { CreateScimTokenDto } from './dto/create-scim-token.dto';
import { ScimTokenService } from './services/scim-token.service';

@UseGuards(JwtAuthGuard)
@Controller('security/scim-tokens')
export class ScimAdminController {
  constructor(private readonly tokens: ScimTokenService) {}

  @Get()
  list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.requireOwner(user);
    return this.tokens.list(workspace.id);
  }

  @Post()
  create(
    @Body() dto: CreateScimTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.tokens.create(dto.name, workspace.id, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(
    @Param('id') id: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.tokens.revoke(id, workspace.id, user.id);
  }

  private requireOwner(user: User): void {
    if (user.role !== UserRole.OWNER) throw new ForbiddenException();
  }
}
