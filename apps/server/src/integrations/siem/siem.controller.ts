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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserRole } from '../../common/helpers/types/permission';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SiemInput, SiemService } from './siem.service';

type DestinationId = { id: string };
type UpdateInput = DestinationId & Partial<SiemInput>;

@UseGuards(JwtAuthGuard)
@Controller('security/siem')
export class SiemController {
  constructor(private readonly siemService: SiemService) {}

  @HttpCode(HttpStatus.OK)
  @Post('list')
  list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.requireOwner(user);
    return this.siemService.list(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  create(
    @Body() input: SiemInput,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.siemService.create(workspace.id, user.id, input);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  update(
    @Body() input: UpdateInput,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    const { id, ...update } = input;
    return this.siemService.update(id, workspace.id, update);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(
    @Body() input: DestinationId,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    await this.siemService.remove(input.id, workspace.id);
  }

  private requireOwner(user: User): void {
    if (user.role !== UserRole.OWNER) throw new ForbiddenException();
  }
}
