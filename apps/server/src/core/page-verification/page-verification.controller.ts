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
import { PageVerificationService } from './page-verification.service';
import {
  ReadConfirmationDto,
  RejectVerificationDto,
  RequestVerificationDto,
  VerificationIdDto,
} from './dto/page-verification.dto';

@UseGuards(JwtAuthGuard)
@Controller('page-verifications')
export class PageVerificationController {
  constructor(private readonly verifications: PageVerificationService) {}
  @Post('list')
  @HttpCode(HttpStatus.OK)
  list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.verifications.list(user, workspace.id);
  }
  @Post('request') request(
    @Body() dto: RequestVerificationDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.verifications.request(user, workspace.id, dto);
  }
  @Post('verify') verify(
    @Body() dto: VerificationIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.verifications.verify(user, workspace.id, dto.verificationId);
  }
  @Post('reject') reject(
    @Body() dto: RejectVerificationDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.verifications.reject(
      user,
      workspace.id,
      dto.verificationId,
      dto.comment,
    );
  }
  @Post('read') @HttpCode(HttpStatus.OK) acknowledge(
    @Body() dto: ReadConfirmationDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.verifications.acknowledge(user, workspace.id, dto.pageId);
  }
}
