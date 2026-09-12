import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, createHash, randomUUID, timingSafeEqual } from 'crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User } from '@docmost/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { TokenService } from '../auth/services/token.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';

const validScopes = new Set(['read', 'write']);
@Injectable()
export class OAuthService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly tokenService: TokenService,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService = {} as IAuditService,
  ) {}

  async register(
    user: User,
    input: {
      name: string;
      redirectUris: string[];
      scopes: string[];
      tokenEndpointAuthMethod?: string;
    },
  ) {
    this.requireAdmin(user);
    this.validateUris(input.redirectUris);
    const scopes = this.scopes(input.scopes);
    const secret = randomBytes(32).toString('base64url');
    const client = await this.db
      .insertInto('oauthClients')
      .values({
        name: input.name,
        redirectUris: input.redirectUris as any,
        scopes: scopes as any,
        grantTypes: ['authorization_code'] as any,
        tokenEndpointAuthMethod:
          input.tokenEndpointAuthMethod ?? 'client_secret_post',
        secretHash: this.hash(secret),
        workspaceId: user.workspaceId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit(
      AuditEvent.OAUTH_CLIENT_REGISTERED,
      user.workspaceId,
      user.id,
      AuditResource.OAUTH_CLIENT,
      client.id,
    );
    return { client: this.redactClient(client), clientSecret: secret };
  }

  async validateAuthorization(
    user: User,
    clientId: string,
    redirectUri: string,
  ): Promise<void> {
    const client = await this.client(clientId, user.workspaceId);
    this.assertRedirect(client.redirectUris, redirectUri);
  }

  async startAuthorization(
    user: User,
    sessionId: string | undefined,
    input: {
      clientId: string;
      redirectUri: string;
      scopes: string[];
      codeChallenge: string;
      codeChallengeMethod: string;
      state?: string;
    },
  ) {
    if (!sessionId)
      throw new UnauthorizedException('session authentication is required');
    const client = await this.client(input.clientId, user.workspaceId);
    this.assertRedirect(client.redirectUris, input.redirectUri);
    const scopes = this.scopes(input.scopes);
    this.assertAllowedScopes(client.scopes, scopes);
    if (input.codeChallengeMethod !== 'S256' || !input.codeChallenge)
      throw new BadRequestException('PKCE S256 is required');
    const transaction = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await this.db
      .insertInto('oauthAuthorizationTransactions')
      .values({
        tokenHash: this.hash(transaction),
        csrfHash: this.hash(csrf),
        sessionId,
        userId: user.id,
        workspaceId: user.workspaceId,
        clientId: client.id,
        redirectUri: input.redirectUri,
        scopes: scopes as any,
        codeChallenge: input.codeChallenge,
        state: input.state ?? null,
        expiresAt: new Date(Date.now() + 300000),
      })
      .execute();
    return { transaction, csrf, scope: scopes.join(' ') };
  }

  async confirmAuthorization(
    user: User,
    sessionId: string | undefined,
    transaction: string,
    csrf: string,
    allowed: boolean,
  ) {
    if (!sessionId)
      throw new UnauthorizedException('session authentication is required');
    const pending = await this.db
      .selectFrom('oauthAuthorizationTransactions')
      .selectAll()
      .where('tokenHash', '=', this.hash(transaction))
      .where('sessionId', '=', sessionId)
      .where('userId', '=', user.id)
      .where('workspaceId', '=', user.workspaceId)
      .where('consumedAt', 'is', null)
      .executeTakeFirst();
    if (
      !pending ||
      pending.expiresAt <= new Date() ||
      !this.matchesHash(pending.csrfHash, csrf)
    ) {
      throw new UnauthorizedException('invalid authorization transaction');
    }
    const consumed = await this.db
      .updateTable('oauthAuthorizationTransactions')
      .set({ consumedAt: new Date() })
      .where('id', '=', pending.id)
      .where('consumedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!consumed)
      throw new UnauthorizedException('invalid authorization transaction');
    if (!allowed) {
      await this.audit(
        AuditEvent.OAUTH_CONSENT_DENIED,
        user.workspaceId,
        user.id,
        AuditResource.OAUTH_CLIENT,
        pending.clientId,
      );
      return {
        redirectUri: this.denialUrl(pending.redirectUri, pending.state),
      };
    }
    await this.audit(
      AuditEvent.OAUTH_CONSENT_GRANTED,
      user.workspaceId,
      user.id,
      AuditResource.OAUTH_CLIENT,
      pending.clientId,
    );
    const code = await this.issueCode(user, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes as string[],
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: 'S256',
    });
    return {
      redirectUri: this.successUrl(pending.redirectUri, code, pending.state),
    };
  }

  listClients(user: User) {
    this.requireAdmin(user);
    return this.db
      .selectFrom('oauthClients')
      .select([
        'id',
        'name',
        'redirectUris',
        'scopes',
        'clientUri',
        'logoUri',
        'createdAt',
      ])
      .where('workspaceId', '=', user.workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async deleteClient(user: User, id: string): Promise<void> {
    this.requireAdmin(user);
    const revokedAt = new Date();
    await this.db
      .updateTable('oauthClients')
      .set({ deletedAt: revokedAt })
      .where('id', '=', id)
      .where('workspaceId', '=', user.workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
    await this.db
      .updateTable('oauthGrants')
      .set({ revokedAt })
      .where('clientId', '=', id)
      .where('workspaceId', '=', user.workspaceId)
      .where('revokedAt', 'is', null)
      .execute();
    await this.db
      .updateTable('oauthTokens')
      .set({ revokedAt })
      .where('workspaceId', '=', user.workspaceId)
      .where(
        'grantId',
        'in',
        this.db
          .selectFrom('oauthGrants')
          .select('id')
          .where('clientId', '=', id)
          .where('workspaceId', '=', user.workspaceId),
      )
      .where('revokedAt', 'is', null)
      .execute();
    await this.audit(
      AuditEvent.OAUTH_CLIENT_DELETED,
      user.workspaceId,
      user.id,
      AuditResource.OAUTH_CLIENT,
      id,
    );
  }

  listGrants(user: User) {
    return this.db
      .selectFrom('oauthGrants')
      .innerJoin('oauthClients', 'oauthClients.id', 'oauthGrants.clientId')
      .select([
        'oauthGrants.id',
        'oauthGrants.scopes',
        'oauthGrants.createdAt',
        'oauthGrants.lastUsedAt',
        'oauthClients.name',
        'oauthClients.clientUri',
        'oauthClients.logoUri',
      ])
      .where('oauthGrants.userId', '=', user.id)
      .where('oauthGrants.workspaceId', '=', user.workspaceId)
      .where('oauthGrants.revokedAt', 'is', null)
      .where('oauthClients.deletedAt', 'is', null)
      .orderBy('oauthGrants.createdAt desc')
      .execute();
  }

  async revokeGrant(user: User, id: string): Promise<void> {
    const revokedAt = new Date();
    const grant = await this.db
      .updateTable('oauthGrants')
      .set({ revokedAt })
      .where('id', '=', id)
      .where('userId', '=', user.id)
      .where('workspaceId', '=', user.workspaceId)
      .where('revokedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!grant) return;
    await this.db
      .updateTable('oauthTokens')
      .set({ revokedAt })
      .where('grantId', '=', grant.id)
      .where('workspaceId', '=', user.workspaceId)
      .where('revokedAt', 'is', null)
      .execute();
    await this.audit(
      AuditEvent.OAUTH_GRANT_REVOKED,
      user.workspaceId,
      user.id,
      AuditResource.OAUTH_GRANT,
      grant.id,
    );
  }

  async issueCode(
    user: User,
    input: {
      clientId: string;
      redirectUri: string;
      scopes: string[];
      codeChallenge: string;
      codeChallengeMethod: string;
    },
  ) {
    const client = await this.client(input.clientId, user.workspaceId);
    this.assertRedirect(client.redirectUris, input.redirectUri);
    const scopes = this.scopes(input.scopes);
    this.assertAllowedScopes(client.scopes, scopes);
    if (input.codeChallengeMethod !== 'S256' || !input.codeChallenge)
      throw new BadRequestException('PKCE S256 is required');
    const code = randomBytes(32).toString('base64url');
    await this.db
      .insertInto('oauthAuthorizationCodes')
      .values({
        codeHash: this.hash(code),
        clientId: client.id,
        userId: user.id,
        workspaceId: user.workspaceId,
        scopes: scopes as any,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + 300000),
      })
      .execute();
    return code;
  }

  async exchange(
    workspaceId: string,
    input: {
      clientId: string;
      clientSecret?: string;
      code: string;
      redirectUri: string;
      codeVerifier: string;
    },
  ) {
    const client = await this.client(input.clientId, workspaceId);
    this.verifyClient(client, input.clientSecret);
    this.assertRedirect(client.redirectUris, input.redirectUri);
    const code = await this.db
      .selectFrom('oauthAuthorizationCodes')
      .selectAll()
      .where('codeHash', '=', this.hash(input.code))
      .where('clientId', '=', client.id)
      .where('workspaceId', '=', workspaceId)
      .where('redirectUri', '=', input.redirectUri)
      .where('consumedAt', 'is', null)
      .executeTakeFirst();
    if (
      !code ||
      code.expiresAt <= new Date() ||
      this.challenge(input.codeVerifier) !== code.codeChallenge
    )
      throw new UnauthorizedException('invalid_grant');
    const consumed = await this.db
      .updateTable('oauthAuthorizationCodes')
      .set({ consumedAt: new Date() })
      .where('id', '=', code.id)
      .where('consumedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!consumed) throw new UnauthorizedException('invalid_grant');
    const grant = await this.upsertGrant(
      code.userId,
      client.id,
      workspaceId,
      code.scopes as string[],
    );
    await this.audit(
      AuditEvent.OAUTH_GRANT_CREATED,
      workspaceId,
      code.userId,
      AuditResource.OAUTH_GRANT,
      grant.id,
    );
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', code.userId)
      .where('workspaceId', '=', workspaceId)
      .where('deactivatedAt', 'is', null)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedException('invalid_grant');
    const jti = randomUUID();
    const token = await this.tokenService.generateOAuthToken({
      user,
      workspaceId,
      grantId: grant.id,
      scope: (code.scopes as string[]).join(' '),
      audience: client.id,
      jti,
      expiresIn: '15m',
    });
    await this.db
      .insertInto('oauthTokens')
      .values({
        grantId: grant.id,
        workspaceId,
        accessTokenJti: jti,
        scopes: code.scopes,
        accessExpiresAt: new Date(Date.now() + 900000),
      })
      .execute();
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 900,
      scope: (code.scopes as string[]).join(' '),
    };
  }

  async revoke(workspaceId: string, token: string): Promise<void> {
    try {
      const payload = await this.tokenService.verifyJwt(token, 'oauth_access');
      await this.db
        .updateTable('oauthTokens')
        .set({ revokedAt: new Date() })
        .where('workspaceId', '=', workspaceId)
        .where('accessTokenJti', '=', payload.jti)
        .execute();
    } catch {
      return;
    }
  }
  async validateOAuthToken(payload: any, workspaceId: string) {
    if (workspaceId !== payload.workspaceId) throw new UnauthorizedException();
    const row = await this.db
      .selectFrom('oauthTokens')
      .innerJoin('oauthGrants', 'oauthGrants.id', 'oauthTokens.grantId')
      .innerJoin('oauthClients', 'oauthClients.id', 'oauthGrants.clientId')
      .innerJoin('users', 'users.id', 'oauthGrants.userId')
      .select(['oauthTokens.accessExpiresAt', 'oauthGrants.clientId'])
      .where('oauthTokens.workspaceId', '=', workspaceId)
      .where('oauthTokens.accessTokenJti', '=', payload.jti)
      .where('oauthTokens.revokedAt', 'is', null)
      .where('oauthGrants.revokedAt', 'is', null)
      .where('oauthClients.deletedAt', 'is', null)
      .where('oauthClients.workspaceId', '=', workspaceId)
      .where('users.workspaceId', '=', workspaceId)
      .where('users.deactivatedAt', 'is', null)
      .where('users.deletedAt', 'is', null)
      .executeTakeFirst();
    if (
      !row ||
      row.accessExpiresAt <= new Date() ||
      row.clientId !== payload.aud ||
      payload.iss !== this.environmentService.getAppUrl()
    )
      throw new UnauthorizedException();
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', payload.sub)
      .where('workspaceId', '=', workspaceId)
      .where('deactivatedAt', 'is', null)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!user) throw new UnauthorizedException();
    return {
      user,
      workspace: await this.db
        .selectFrom('workspaces')
        .selectAll()
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow(),
      oauth: { grantId: payload.grantId, scopes: payload.scope.split(' ') },
    };
  }

  private async client(id: string, workspaceId: string) {
    const client = await this.db
      .selectFrom('oauthClients')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!client) throw new UnauthorizedException('invalid_client');
    return client;
  }
  private async upsertGrant(
    userId: string,
    clientId: string,
    workspaceId: string,
    scopes: string[],
  ) {
    return this.db
      .insertInto('oauthGrants')
      .values({ userId, clientId, workspaceId, scopes: scopes as any })
      .onConflict((oc) =>
        oc.columns(['userId', 'clientId']).doUpdateSet({
          scopes: scopes as any,
          revokedAt: null,
          updatedAt: new Date(),
          lastUsedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  private validateUris(uris: string[]) {
    if (!uris.length)
      throw new BadRequestException('redirect_uris is required');
    uris.forEach((uri) => {
      const parsed = new URL(uri);
      if (
        parsed.hash ||
        (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost')
      )
        throw new BadRequestException('invalid redirect URI');
    });
  }
  private assertAllowedScopes(allowed: any, requested: string[]) {
    if (
      !Array.isArray(allowed) ||
      requested.some((scope) => !allowed.includes(scope))
    )
      throw new BadRequestException('invalid scope');
  }
  private assertRedirect(uris: any, redirectUri: string) {
    if (!Array.isArray(uris) || !uris.includes(redirectUri))
      throw new BadRequestException('invalid redirect_uri');
  }
  private scopes(scopes: string[]) {
    if (!scopes.length || scopes.some((scope) => !validScopes.has(scope)))
      throw new BadRequestException('invalid scope');
    return [...new Set(scopes)];
  }
  private verifyClient(client: any, secret?: string) {
    if (
      client.tokenEndpointAuthMethod !== 'none' &&
      (!secret || client.secretHash !== this.hash(secret))
    )
      throw new UnauthorizedException('invalid_client');
  }
  private challenge(verifier: string) {
    return createHash('sha256').update(verifier).digest('base64url');
  }
  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  private matchesHash(expected: string, value: string): boolean {
    const left = Buffer.from(expected);
    const right = Buffer.from(this.hash(value));
    return left.length === right.length && timingSafeEqual(left, right);
  }
  private successUrl(uri: string, code: string, state: string | null) {
    const url = new URL(uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return url.toString();
  }
  private denialUrl(uri: string, state: string | null) {
    const url = new URL(uri);
    url.searchParams.set('error', 'access_denied');
    if (state) url.searchParams.set('state', state);
    return url.toString();
  }
  private redactClient(client: any) {
    const { secretHash: _secretHash, ...safeClient } = client;
    return safeClient;
  }
  private async audit(
    event: (typeof AuditEvent)[keyof typeof AuditEvent],
    workspaceId: string,
    actorId: string,
    resourceType: (typeof AuditResource)[keyof typeof AuditResource],
    resourceId: string,
  ): Promise<void> {
    await this.auditService.logWithContext?.(
      { event, resourceType, resourceId },
      { workspaceId, actorId, actorType: 'user' },
    );
  }
  private requireAdmin(user: User) {
    if (user.role === UserRole.MEMBER) throw new ForbiddenException();
  }
}
