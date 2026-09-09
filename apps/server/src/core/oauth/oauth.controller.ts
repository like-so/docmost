import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { User } from '@docmost/db/types/entity.types';
import { OAuthService } from './oauth.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';

class RegisterClientDto {
  @IsString() @MaxLength(120) name: string;
  @IsArray() @IsString({ each: true }) redirectUris: string[];
  @IsArray() @IsString({ each: true }) scopes: string[];
  @IsOptional()
  @IsIn(['none', 'client_secret_post'])
  tokenEndpointAuthMethod?: string;
}
class TokenDto {
  @IsString() grant_type: string;
  @IsString() client_id: string;
  @IsString() code: string;
  @IsString() redirect_uri: string;
  @IsString() code_verifier: string;
  @IsOptional() @IsString() client_secret?: string;
}
class RevokeDto {
  @IsString() token: string;
}
class ConfirmAuthorizationDto {
  @IsString() transaction: string;
  @IsString() csrf: string;
  @IsIn(['allow', 'deny']) decision: 'allow' | 'deny';
}

@Controller('oauth')
export class OAuthController {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly environmentService: EnvironmentService,
  ) {}
  @UseGuards(JwtAuthGuard) @RequireSessionAuth() @Post('clients') register(
    @AuthUser() user: User,
    @Body() dto: RegisterClientDto,
  ) {
    return this.oauthService.register(user, dto);
  }
  @UseGuards(JwtAuthGuard) @RequireSessionAuth() @Get('clients') list(
    @AuthUser() user: User,
  ) {
    return this.oauthService.listClients(user);
  }
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @Delete('clients/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@AuthUser() user: User, @Param('id') id: string) {
    await this.oauthService.deleteClient(user, id);
  }
  @UseGuards(JwtAuthGuard) @RequireSessionAuth() @Get('grants') grants(
    @AuthUser() user: User,
  ) {
    return this.oauthService.listGrants(user);
  }
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @Delete('grants/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeGrant(@AuthUser() user: User, @Param('id') id: string) {
    await this.oauthService.revokeGrant(user, id);
  }
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @Get('authorize')
  async authorize(
    @AuthUser() user: User,
    @Req() req: FastifyRequest,
    @Query() query: any,
    @Res() res: FastifyReply,
  ) {
    if (query.response_type !== 'code')
      throw new Error('unsupported_response_type');
    const pending = await this.oauthService.startAuthorization(
      user,
      (req.raw as any).sessionId,
      {
        clientId: query.client_id,
        redirectUri: query.redirect_uri,
        scopes: String(query.scope ?? '')
          .split(' ')
          .filter(Boolean),
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
        state: query.state,
      },
    );
    return res.redirect(
      `/oauth/consent?${new URLSearchParams(pending).toString()}`,
    );
  }
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @Post('authorize/confirm')
  async confirm(
    @AuthUser() user: User,
    @Req() req: FastifyRequest,
    @Body() dto: ConfirmAuthorizationDto,
  ) {
    if (req.headers.origin !== this.environmentService.getAppUrl()) {
      throw new Error('invalid_origin');
    }
    return this.oauthService.confirmAuthorization(
      user,
      (req.raw as any).sessionId,
      dto.transaction,
      dto.csrf,
      dto.decision === 'allow',
    );
  }
  @Public() @Post('token') @HttpCode(HttpStatus.OK) token(
    @Req() req: FastifyRequest,
    @Body() dto: TokenDto,
  ) {
    if (dto.grant_type !== 'authorization_code')
      throw new Error('unsupported_grant_type');
    return this.oauthService.exchange((req.raw as any).workspaceId, {
      clientId: dto.client_id,
      clientSecret: dto.client_secret,
      code: dto.code,
      redirectUri: dto.redirect_uri,
      codeVerifier: dto.code_verifier,
    });
  }
  @Public() @Post('revoke') @HttpCode(HttpStatus.OK) async revoke(
    @Req() req: FastifyRequest,
    @Body() dto: RevokeDto,
  ) {
    await this.oauthService.revoke((req.raw as any).workspaceId, dto.token);
    return {};
  }
}
