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
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../integrations/throttle/throttler-names';

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
  @HttpCode(200)
  verify(
    @Body() body: { attemptId: string; code: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfa.enable(user.id, workspace.id, body.attemptId, body.code);
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
  @SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
  @UseGuards(ThrottlerGuard)
  @Post('challenge')
  async challenge(
    @Body() body: {
      challengeId: string;
      kind: 'totp' | 'backup';
      code: string;
    },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = await this.auth.completeMfaLogin(
      body.challengeId,
      body.kind,
      body.code,
    );
    reply.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environment.getCookieExpiresIn(),
      secure: this.environment.isHttps(),
    });
  }

  @Public()
  @SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
  @UseGuards(ThrottlerGuard)
  @Post('setup/challenge')
  setupChallenge(@Body() body: { setupId: string }) {
    return this.auth.startMfaSetup(body.setupId);
  }

  @Public()
  @SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
  @UseGuards(ThrottlerGuard)
  @Post('setup/challenge/verify')
  async verifySetupChallenge(
    @Body() body: { setupId: string; attemptId: string; code: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.completeMfaSetup(
      body.setupId,
      body.attemptId,
      body.code,
    );
    reply.setCookie('authToken', result.authToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environment.getCookieExpiresIn(),
      secure: this.environment.isHttps(),
    });
    return { backupCodes: result.backupCodes };
  }
}
