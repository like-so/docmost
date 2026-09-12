import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OAUTH_SCOPE_KEY } from '../decorators/oauth-scope.decorator';
import { REQUIRE_SESSION_AUTH_KEY } from '../decorators/require-session-auth.decorator';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { ENFORCE_MCP_OAUTH_KEY } from '../decorators/enforce-mcp-oauth.decorator';

const handlerSentinel = () => 'handler';
const classSentinel = class Controller {};

function createCtx(): ExecutionContext {
  return {
    getHandler: () => handlerSentinel,
    getClass: () => classSentinel,
  } as any;
}

function createGuard(
  scopeMetadata?: unknown,
  requireSession?: boolean,
  requireMcpOauth?: boolean,
) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === REQUIRE_SESSION_AUTH_KEY) return requireSession;
      if (key === ENFORCE_MCP_OAUTH_KEY) return requireMcpOauth;
      return scopeMetadata;
    }),
  } as any;
  const environmentService = {
    isCloud: jest.fn().mockReturnValue(false),
  } as any;
  const guard = new JwtAuthGuard(reflector, environmentService);
  return { guard, reflector };
}

function oauthUser(scopes: string[]) {
  return {
    user: { id: 'user_1' },
    workspace: { id: 'ws_1' },
    oauth: { grantId: 'grant_1', scopes },
  };
}

function apiKeyUser(scopes: string[]) {
  return {
    user: { id: 'user_1' },
    workspace: { id: 'ws_1' },
    authType: JwtType.API_KEY,
    apiKey: { id: 'key_1', scopes },
  };
}

describe('JwtAuthGuard.handleRequest', () => {
  it('rethrows the strategy error', () => {
    const { guard } = createGuard();
    const err = new UnauthorizedException('bad token');

    expect(() => guard.handleRequest(err, null, null, createCtx())).toThrow(err);
  });

  it('throws UnauthorizedException when there is no user', () => {
    const { guard } = createGuard();

    expect(() => guard.handleRequest(null, null, null, createCtx())).toThrow(
      UnauthorizedException,
    );
  });

  it('returns a non-oauth user untouched without consulting scope metadata', () => {
    const { guard, reflector } = createGuard();
    const user = { user: { id: 'user_1' }, workspace: { id: 'ws_1' } };

    expect(guard.handleRequest(null, user, null, createCtx())).toBe(user);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalledWith(
      OAUTH_SCOPE_KEY,
      expect.anything(),
    );
  });

  it('forbids an oauth user on a route without scope metadata', () => {
    const { guard, reflector } = createGuard(undefined);

    expect(() =>
      guard.handleRequest(null, oauthUser(['read', 'write']), null, createCtx()),
    ).toThrow(ForbiddenException);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(OAUTH_SCOPE_KEY, [
      handlerSentinel,
      classSentinel,
    ]);
  });

  it('passes read scope on a read route', () => {
    const { guard } = createGuard('read');
    const user = oauthUser(['read']);

    expect(guard.handleRequest(null, user, null, createCtx())).toBe(user);
  });

  it('forbids read scope on a write route with insufficient_scope', () => {
    const { guard } = createGuard('write');

    expect(() =>
      guard.handleRequest(null, oauthUser(['read']), null, createCtx()),
    ).toThrow('insufficient_scope');
  });

  it('passes write scope on a read route', () => {
    const { guard } = createGuard('read');
    const user = oauthUser(['write']);

    expect(guard.handleRequest(null, user, null, createCtx())).toBe(user);
  });

  it('passes write scope on a write route', () => {
    const { guard } = createGuard('write');
    const user = oauthUser(['write']);

    expect(guard.handleRequest(null, user, null, createCtx())).toBe(user);
  });

  describe('session-only routes', () => {
    const sessionUser = {
      user: { id: 'user_1' },
      workspace: { id: 'ws_1' },
      authType: JwtType.ACCESS,
    };

    it('allows a signed-in session', () => {
      const { guard } = createGuard(undefined, true);

      expect(guard.handleRequest(null, sessionUser, null, createCtx())).toBe(
        sessionUser,
      );
    });

    it('forbids an api key', () => {
      const { guard } = createGuard(undefined, true);
      const apiKeyUser = {
        user: { id: 'user_1' },
        workspace: { id: 'ws_1' },
        authType: JwtType.API_KEY,
      };

      expect(() =>
        guard.handleRequest(null, apiKeyUser, null, createCtx()),
      ).toThrow('This action requires an interactive user session');
    });

    it('forbids an oauth token even when it carries write scope', () => {
      const { guard } = createGuard('write', true);
      const user = { ...oauthUser(['write']), authType: JwtType.OAUTH_ACCESS };

      expect(() => guard.handleRequest(null, user, null, createCtx())).toThrow(
        'This action requires an interactive user session',
      );
    });

    it('forbids api keys on routes without a scope marker', () => {
      const { guard } = createGuard(undefined, undefined);
      expect(() =>
        guard.handleRequest(null, apiKeyUser(['write']), null, createCtx()),
      ).toThrow('Programmatic tokens cannot access this endpoint');
    });
  });

  describe('MCP OAuth enforcement', () => {
    const workspace = { settings: { ai: { enforceMcpOauth: true } } };

    it('rejects a session when MCP OAuth is enforced', () => {
      const { guard } = createGuard('read', undefined, true);
      const session = { user: { id: 'user' }, workspace, authType: JwtType.ACCESS };

      expect(() => guard.handleRequest(null, session, null, createCtx())).toThrow(
        'MCP requires an OAuth access token',
      );
    });

    it('rejects an API key when MCP OAuth is enforced', () => {
      const { guard } = createGuard('read', undefined, true);
      const apiKey = { ...apiKeyUser(['read']), workspace };

      expect(() => guard.handleRequest(null, apiKey, null, createCtx())).toThrow(
        'MCP requires an OAuth access token',
      );
    });

    it('allows a read-scoped OAuth token when MCP OAuth is enforced', () => {
      const { guard } = createGuard('read', undefined, true);
      const oauth = { ...oauthUser(['read']), workspace, authType: JwtType.OAUTH_ACCESS };

      expect(guard.handleRequest(null, oauth, null, createCtx())).toBe(oauth);
    });

    it('allows supported session and API-key credentials when disabled', () => {
      const { guard } = createGuard('read', undefined, true);
      const workspace = { settings: { ai: { enforceMcpOauth: false } } };
      const session = { user: { id: 'user' }, workspace, authType: JwtType.ACCESS };
      const apiKey = { ...apiKeyUser(['read']), workspace };

      expect(guard.handleRequest(null, session, null, createCtx())).toBe(session);
      expect(guard.handleRequest(null, apiKey, null, createCtx())).toBe(apiKey);
    });
  });

  describe('API key scopes', () => {
    it('allows read keys on read routes but not write routes', () => {
      const read = createGuard('read').guard;
      const write = createGuard('write').guard;
      const user = apiKeyUser(['read']);

      expect(read.handleRequest(null, user, null, createCtx())).toBe(user);
      expect(() => write.handleRequest(null, user, null, createCtx())).toThrow(
        'insufficient_scope',
      );
    });

    it.each([['admin'], ['*']])(
      'allows the %s API key scope on mutable routes',
      (scope) => {
        const { guard } = createGuard('write');
        const user = apiKeyUser([scope]);

        expect(guard.handleRequest(null, user, null, createCtx())).toBe(user);
      },
    );
  });

  it('lets handler metadata override class metadata', () => {
    const metadataByTarget = new Map<unknown, string>([
      [handlerSentinel, 'write'],
      [classSentinel, 'read'],
    ]);
    const reflector = {
      getAllAndOverride: jest.fn((key: string, targets: unknown[]) => {
        if (key === REQUIRE_SESSION_AUTH_KEY) {
          return undefined;
        }
        for (const target of targets) {
          if (metadataByTarget.has(target)) {
            return metadataByTarget.get(target);
          }
        }
        return undefined;
      }),
    } as any;
    const environmentService = { isCloud: jest.fn().mockReturnValue(false) } as any;
    const guard = new JwtAuthGuard(reflector, environmentService);

    expect(() =>
      guard.handleRequest(null, oauthUser(['read']), null, createCtx()),
    ).toThrow('insufficient_scope');
  });
});
