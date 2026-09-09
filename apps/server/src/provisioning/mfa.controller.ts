import {
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { MfaService } from './services/mfa.service';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from '../core/auth/services/auth.service';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { FastifyReply } from 'fastify';

@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly environment: EnvironmentService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('setup')
  async setup(
    @Body() body: { code?: string; password?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const passwordVerified = await this.auth.verifyMfaPassword(
      user.id,
      workspace.id,
      body.password,
    );
    return this.mfa.setup(
      user.id,
      workspace.id,
      user.email,
      body.code,
      passwordVerified,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify')
  @HttpCode(204)
  verify(
    @Body() body: { code: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfa.enable(user.id, workspace.id, body.code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('disable')
  @HttpCode(204)
  disable(
    @Body() body: { code: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfa.disable(user.id, workspace.id, body.code);
  }

  @Public()
  @Post('challenge')
  async challenge(
    @Body() body: { challengeId: string; code: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = await this.auth.completeMfaLogin(body.challengeId, body.code);
    reply.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environment.getCookieExpiresIn(),
      secure: this.environment.isHttps(),
    });
  }

  @Public()
  @Post('setup/challenge')
  setupChallenge(@Body() body: { setupId: string }) {
    return this.auth.startMfaSetup(body.setupId);
  }

  @Public()
  @Post('setup/challenge/verify')
  async verifySetupChallenge(
    @Body() body: { setupId: string; code: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = await this.auth.completeMfaSetup(body.setupId, body.code);
    reply.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environment.getCookieExpiresIn(),
      secure: this.environment.isHttps(),
    });
  }
}
