import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { User } from '@docmost/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { TokenService } from '../auth/services/token.service';
import { JwtApiKeyPayload } from '../auth/dto/jwt-payload';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly tokenService: TokenService,
    private readonly workspaceRepo: WorkspaceRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService = {} as IAuditService,
  ) {}

  async create(user: User, name: string, scopes: string[], expiresAt?: Date) {
    await this.requirePersonalAccess(user);
    this.requireScopes(scopes);
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException('expiration must be in the future');
    }
    const key = await this.apiKeyRepo.create({
      name,
      creatorId: user.id,
      workspaceId: user.workspaceId,
      secretHash: '',
      scopes,
      expiresAt,
    });
    const token = await this.tokenService.generateApiToken({
      apiKeyId: key.id,
      user,
      workspaceId: user.workspaceId,
      expiresIn: expiresAt
        ? Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
        : undefined,
    });
    await this.apiKeyRepo.setSecretHash(key.id, this.hash(token));
    await this.audit(AuditEvent.API_KEY_CREATED, user, key.id, {
      after: { name: key.name, scopes: key.scopes, expiresAt: key.expiresAt },
    });
    return { apiKey: this.redact(key), token };
  }

  async list(user: User) {
    await this.requirePersonalAccess(user);
    return this.apiKeyRepo.list(user.workspaceId, user.id);
  }

  async rename(user: User, id: string, name: string): Promise<void> {
    await this.requirePersonalAccess(user);
    await this.apiKeyRepo.rename(id, user.workspaceId, user.id, name);
    await this.audit(AuditEvent.API_KEY_UPDATED, user, id, { after: { name } });
  }

  async revoke(user: User, id: string): Promise<void> {
    await this.requirePersonalAccess(user);
    await this.apiKeyRepo.revoke(id, user.workspaceId, user.id);
    await this.audit(AuditEvent.API_KEY_DELETED, user, id);
  }

  async listWorkspace(user: User) {
    await this.requireWorkspaceAdmin(user);
    return this.apiKeyRepo.listWorkspace(user.workspaceId);
  }

  async renameWorkspace(user: User, id: string, name: string): Promise<void> {
    await this.requireWorkspaceAdmin(user);
    await this.apiKeyRepo.renameWorkspace(id, user.workspaceId, name);
    await this.audit(AuditEvent.API_KEY_UPDATED, user, id, { after: { name } });
  }

  async revokeWorkspace(user: User, id: string): Promise<void> {
    await this.requireWorkspaceAdmin(user);
    await this.apiKeyRepo.revokeWorkspace(id, user.workspaceId);
    await this.audit(AuditEvent.API_KEY_DELETED, user, id);
  }

  async validateApiKey(payload: JwtApiKeyPayload, bearer: string) {
    const key = await this.apiKeyRepo.findActive(
      payload.apiKeyId,
      payload.workspaceId,
    );
    if (
      !key ||
      key.creatorId !== payload.sub ||
      (key.expiresAt && key.expiresAt <= new Date()) ||
      key.secretHash !== this.hash(bearer)
    )
      throw new UnauthorizedException();
    await this.apiKeyRepo.markUsed(key.id);
    return { key, scopes: Array.isArray(key.scopes) ? key.scopes : [] };
  }

  private redact(key: any) {
    const { secretHash: _secretHash, ...safeKey } = key;
    return safeKey;
  }

  private async audit(
    event: (typeof AuditEvent)[keyof typeof AuditEvent],
    user: User,
    resourceId: string,
    changes?: { after?: Record<string, unknown> },
  ): Promise<void> {
    await this.auditService.logWithContext?.(
      { event, resourceType: AuditResource.API_KEY, resourceId, changes },
      { workspaceId: user.workspaceId, actorId: user.id, actorType: 'user' },
    );
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async requirePersonalAccess(user: User): Promise<void> {
    if (user.role !== UserRole.MEMBER) return;
    const workspace = await this.workspaceRepo.findById(user.workspaceId);
    const settings = workspace?.settings as {
      api?: { restrictApiKeysToAdmins?: boolean; restrictToAdmins?: boolean };
    } | null;
    if (
      settings?.api?.restrictApiKeysToAdmins ||
      settings?.api?.restrictToAdmins
    )
      throw new ForbiddenException();
  }

  private async requireWorkspaceAdmin(user: User): Promise<void> {
    if (user.role === UserRole.MEMBER) throw new ForbiddenException();
    await this.requirePersonalAccess(user);
  }

  private requireScopes(scopes: string[]): void {
    const validScopes = new Set(['read', 'write', 'admin', '*']);
    if (!scopes.length || scopes.some((scope) => !validScopes.has(scope))) {
      throw new BadRequestException('invalid scope');
    }
  }
}
