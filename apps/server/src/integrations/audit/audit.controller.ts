import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserRole } from '../../common/helpers/types/permission';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AuditFilter } from '../../database/repos/audit/audit.repo';
import { AUDIT_SERVICE } from './audit.service';
import { DurableAuditService } from './durable-audit.service';

@UseGuards(JwtAuthGuard)
@Controller('security/audit')
export class AuditController {
  constructor(
    @Inject(AUDIT_SERVICE) private readonly auditService: DurableAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('list')
  list(
    @Body() filter: AuditFilter,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.auditService.list(workspace.id, filter);
  }

  @HttpCode(HttpStatus.OK)
  @Post('export')
  export(
    @Body() filter: AuditFilter,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.auditService.list(workspace.id, { ...filter, limit: 200 });
  }

  private requireOwner(user: User): void {
    if (user.role !== UserRole.OWNER) throw new ForbiddenException();
  }
}
