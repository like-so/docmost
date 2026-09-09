import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { DomainService } from '../../integrations/environment/domain.service';
import { buildCallbackUrl, buildWorkspaceUrl } from './callback-url.util';
import { samlBindingCookie } from './saml-cookie.util';
import { SsoCapabilityService } from './sso-capability.service';
import { OidcService } from './oidc.service';
import { FastifyReply } from 'fastify';
import { LdapService } from './ldap.service';
import { SamlService } from './saml.service';
import { AuthProviderService } from './auth-provider.service';
import { LoginResult } from '../auth/services/auth.service';

@Public()
@Controller('sso')
export class SsoController {
  constructor(
    private readonly oidc: OidcService,
    private readonly environment: EnvironmentService,
    private readonly domain: DomainService,
    private readonly capability: SsoCapabilityService,
    private readonly ldap: LdapService,
    private readonly saml: SamlService,
    private readonly providers: AuthProviderService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post(':id')
  async start(
    @Param('id') id: string,
    @AuthWorkspace() workspace: Workspace,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.capability.assertEnabled();
    const provider = await this.providers.findEnabled(workspace.id, id);
    if (provider.type === 'saml') {
      const { url, binding } = await this.saml.start(
        workspace.id,
        id,
        this.callbackUrl(workspace, id),
      );
      reply.setCookie('samlBinding', binding, samlBindingCookie(id));
      return { url };
    }
    const { url, binding } = await this.oidc.start(
      workspace.id,
      id,
      this.callbackUrl(workspace, id),
    );
    reply.setCookie('oidcBinding', binding, {
      httpOnly: true,
      sameSite: 'lax',
      path: `/api/sso/${id}/callback`,
      maxAge: 600,
      secure: this.environment.isHttps(),
    });
    return { url: url.toString() };
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/ldap')
  async ldapLogin(
    @Param('id') id: string,
    @Body() body: { username: string; password: string },
    @AuthWorkspace() workspace: Workspace,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.capability.assertEnabled();
    const result = await this.ldap.login(
      workspace.id,
      id,
      body.username,
      body.password,
    );
    return this.completeLogin(result, reply);
  }

  @Get(':id/callback')
  async callback(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.capability.assertEnabled();
    const url = new URL(request.url, this.environment.getAppUrl());
    try {
      const result = await this.oidc.callback(
        workspace.id,
        url,
        this.callbackUrl(workspace, id),
        request.cookies?.oidcBinding,
      );
      reply.clearCookie('oidcBinding', { path: `/api/sso/${id}/callback` });
      return this.redirectLogin(result, workspace, reply);
    } catch {
      reply.clearCookie('oidcBinding', { path: `/api/sso/${id}/callback` });
      return reply.redirect(this.failedLoginUrl(workspace));
    }
  }

  @Post(':id/callback')
  async samlCallback(
    @Param('id') id: string,
    @Body() body: { SAMLResponse?: string; RelayState?: string },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.capability.assertEnabled();
    try {
      if (!body.SAMLResponse) {
        reply.clearCookie('samlBinding', {
          path: `/api/sso/${id}/callback`,
        });
        return reply.redirect(this.failedLoginUrl(workspace));
      }
      const result = await this.saml.callback(
        workspace.id,
        id,
        this.callbackUrl(workspace, id),
        body.SAMLResponse,
        body.RelayState,
        request.cookies?.samlBinding,
      );
      reply.clearCookie('samlBinding', { path: `/api/sso/${id}/callback` });
      return this.redirectLogin(result, workspace, reply);
    } catch {
      reply.clearCookie('samlBinding', { path: `/api/sso/${id}/callback` });
      return reply.redirect(this.failedLoginUrl(workspace));
    }
  }

  private redirectLogin(
    result: LoginResult,
    workspace: Workspace,
    reply: FastifyReply,
  ) {
    if ('mfaRequired' in result) {
      return reply.redirect(this.mfaUrl(workspace, result.challengeId));
    }
    if ('mfaSetupRequired' in result) {
      return reply.redirect(this.mfaSetupUrl(workspace, result.setupId));
    }
    this.setAuthCookie(reply, result.authToken);
    return reply.redirect(this.workspaceUrl(workspace));
  }

  private failedLoginUrl(workspace: Workspace): string {
    return `${this.workspaceUrl(workspace)}/login?sso_error=1`;
  }

  private callbackUrl(workspace: Workspace, id: string): string {
    return buildCallbackUrl(
      this.domain.getUrl(workspace.hostname),
      this.environment.isCloud(),
      this.environment.getSubdomainHost(),
      workspace.hostname,
      id,
    );
  }

  private workspaceUrl(workspace: Workspace): string {
    return buildWorkspaceUrl(
      this.domain.getUrl(workspace.hostname),
      this.environment.isCloud(),
      this.environment.getSubdomainHost(),
      workspace.hostname,
    );
  }

  private completeLogin(result: LoginResult, reply: FastifyReply) {
    if (!('authToken' in result)) return result;
    this.setAuthCookie(reply, result.authToken);
  }

  private setAuthCookie(reply: FastifyReply, token: string): void {
    reply.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environment.getCookieExpiresIn(),
      secure: this.environment.isHttps(),
    });
  }

  private mfaUrl(workspace: Workspace, challengeId: string): string {
    return `${this.workspaceUrl(workspace)}/login/mfa#challengeId=${encodeURIComponent(challengeId)}`;
  }

  private mfaSetupUrl(workspace: Workspace, setupId: string): string {
    return `${this.workspaceUrl(workspace)}/login/mfa/setup#setupId=${encodeURIComponent(setupId)}`;
  }
}
