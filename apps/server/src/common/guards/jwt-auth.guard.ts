import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  OAUTH_SCOPE_KEY,
  OAuthRouteScope,
} from '../decorators/oauth-scope.decorator';
import { REQUIRE_SESSION_AUTH_KEY } from '../decorators/require-session-auth.decorator';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { ENFORCE_MCP_OAUTH_KEY } from '../decorators/enforce-mcp-oauth.decorator';
import { Reflector } from '@nestjs/core';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { addDays } from 'date-fns';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private logger = new Logger('JwtAuthGuard');

  constructor(
    private reflector: Reflector,
    private environmentService: EnvironmentService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, ctx: ExecutionContext) {
    if (err || !user) {
      throw err || new UnauthorizedException();
    }

    const requiresSession = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_SESSION_AUTH_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (requiresSession && user.authType !== JwtType.ACCESS) {
      this.logger.debug(
        `session-only endpoint ${ctx.getClass()?.name}.${ctx.getHandler()?.name} refused authType ${user.authType}`,
      );
      throw new ForbiddenException(
        'This action requires an interactive user session',
      );
    }

    const requiresMcpOauth = this.reflector.getAllAndOverride<boolean>(
      ENFORCE_MCP_OAUTH_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    const mcpOauthEnforced = user.workspace?.settings?.ai?.enforceMcpOauth;
    if (requiresMcpOauth && mcpOauthEnforced && !user.oauth) {
      throw new ForbiddenException('MCP requires an OAuth access token');
    }

    if (user.oauth || user.authType === JwtType.API_KEY) {
      const required = this.reflector.getAllAndOverride<
        OAuthRouteScope | undefined
      >(OAUTH_SCOPE_KEY, [ctx.getHandler(), ctx.getClass()]);
      if (!required) {
        this.logger.warn(
          `programmatic scope check: no @OAuthScope metadata on ${ctx.getClass()?.name}.${ctx.getHandler()?.name}`,
        );
        throw new ForbiddenException(
          'Programmatic tokens cannot access this endpoint',
        );
      }
      const scopes: string[] = user.oauth?.scopes ?? user.apiKey?.scopes ?? [];
      const satisfied =
        scopes.includes('*') ||
        scopes.includes('admin') ||
        (required === 'read'
          ? scopes.includes('read') || scopes.includes('write')
          : scopes.includes('write'));
      if (!satisfied) {
        throw new ForbiddenException('insufficient_scope');
      }
    }

    this.setJoinedWorkspacesCookie(user, ctx);
    return user;
  }

  setJoinedWorkspacesCookie(user: any, ctx: ExecutionContext) {
    if (this.environmentService.isCloud()) {
      const req = ctx.switchToHttp().getRequest();
      const res = ctx.switchToHttp().getResponse();

      const workspaceId = user?.workspace?.id;
      let workspaceIds = [];
      try {
        workspaceIds = req.cookies.joinedWorkspaces
          ? JSON.parse(req.cookies.joinedWorkspaces)
          : [];
      } catch (err) {
        /* empty */
      }

      if (!workspaceIds.includes(workspaceId)) {
        workspaceIds.push(workspaceId);
      }

      res.setCookie('joinedWorkspaces', JSON.stringify(workspaceIds), {
        httpOnly: false,
        domain: '.' + this.environmentService.getSubdomainHost(),
        path: '/',
        expires: addDays(new Date(), 365),
        secure: this.environmentService.isHttps(),
      });
    }
  }
}
