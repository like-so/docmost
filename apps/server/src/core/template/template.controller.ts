import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { TemplateService } from './template.service';
import {
  CreateTemplateDto,
  InstantiateTemplateDto,
  TemplateIdDto,
  UpdateTemplateDto,
} from './dto/template.dto';

@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}
  @Post() @HttpCode(HttpStatus.OK) list(
    @Body() page: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templates.list(user, workspace.id, page);
  }
  @Post('create') create(
    @Body() dto: CreateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templates.create(user, workspace.id, dto);
  }
  @Post('update') update(
    @Body() dto: UpdateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templates.update(user, workspace.id, dto);
  }
  @Post('delete') remove(
    @Body() dto: TemplateIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templates.remove(user, workspace.id, dto.templateId);
  }
  @Post('instantiate') instantiate(
    @Body() dto: InstantiateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templates.instantiate(user, workspace.id, dto);
  }
}
