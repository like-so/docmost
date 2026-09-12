import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { User, Workspace } from '@docmost/db/types/entity.types';
import {
  PagePermissionPageDto,
  UpdatePagePermissionDto,
} from './dto/page-permission.dto';
import { PagePermissionService } from './page-permission.service';

@UseGuards(JwtAuthGuard)
@Controller('page-permissions')
export class PagePermissionController {
  constructor(private readonly pagePermissions: PagePermissionService) {}

  @HttpCode(HttpStatus.OK)
  @Post('/')
  getPermissions(
    @Body() dto: PagePermissionPageDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissions.getPermissions(
      dto.pageId,
      user,
      workspace.id,
      pagination,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  updatePermissions(
    @Body() dto: UpdatePagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissions.updatePermissions(
      dto.pageId,
      user,
      workspace.id,
      dto.inherit === true,
      dto.members ?? [],
    );
  }
}
