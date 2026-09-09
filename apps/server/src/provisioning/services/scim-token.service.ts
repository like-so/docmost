import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SCIM_TOKEN_STORE, ScimTokenStore } from '../ports/scim-token.store';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';

@Injectable()
export class ScimTokenService {
  constructor(
    @Inject(SCIM_TOKEN_STORE) private readonly store: ScimTokenStore,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService = {} as IAuditService,
  ) {}

  async create(name: string, workspaceId: string, creatorId: string) {
    await this.assertEnabled(workspaceId, false);
    const token = `scim_${randomBytes(32).toString('base64url')}`;
    const record = await this.store.create({
      name,
      workspaceId,
      creatorId,
      tokenHash: this.hash(token),
      tokenLastFour: token.slice(-4),
    });
    await this.audit(AuditEvent.SCIM_TOKEN_CREATED, workspaceId, creatorId, record.id, {
      after: { name: record.name, lastFour: record.tokenLastFour },
    });
    return {
      id: record.id,
      name: record.name,
      token,
      lastFour: record.tokenLastFour,
    };
  }

  async authenticate(token: string): Promise<string> {
    if (!token) throw new UnauthorizedException('Invalid SCIM bearer token');
    const record = await this.store.findActiveByHash(this.hash(token));
    if (!record?.workspaceId || !record.isEnabled) {
      throw new UnauthorizedException('Invalid SCIM bearer token');
    }
    await this.assertEnabled(record.workspaceId, true);
    await this.store.markUsed(record.id);
    return record.workspaceId;
  }

  async revoke(id: string, workspaceId: string, actorId: string): Promise<void> {
    await this.store.revoke(id, workspaceId);
    await this.audit(AuditEvent.SCIM_TOKEN_DELETED, workspaceId, actorId, id);
  }

  async list(workspaceId: string) {
    const tokens = await this.store.list(workspaceId);
    return tokens.map(({ id, name, tokenLastFour, isEnabled, createdAt }) => ({
      id,
      name,
      lastFour: tokenLastFour,
      isEnabled,
      createdAt,
    }));
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async audit(
    event: (typeof AuditEvent)[keyof typeof AuditEvent],
    workspaceId: string,
    actorId: string,
    resourceId: string,
    changes?: { after?: Record<string, unknown> },
  ): Promise<void> {
    await this.auditService.logWithContext?.(
      { event, resourceType: AuditResource.SCIM_TOKEN, resourceId, changes },
      { workspaceId, actorId, actorType: 'user' },
    );
  }

  private async assertEnabled(
    workspaceId: string,
    unauthenticated: boolean,
  ): Promise<void> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select('isScimEnabled')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    if (!workspace?.isScimEnabled) {
      if (unauthenticated) {
        throw new UnauthorizedException('Invalid SCIM bearer token');
      }
      throw new ForbiddenException('SCIM is disabled for this workspace');
    }
  }
}
