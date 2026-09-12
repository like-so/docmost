import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ActorType,
  AuditLogData,
  AuditLogPayload,
} from '../../common/events/audit-events';
import {
  AuditContext,
  AUDIT_CONTEXT_KEY,
} from '../../common/middlewares/audit-context.middleware';
import { AuditFilter, AuditRepo } from '../../database/repos/audit/audit.repo';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { AuditLogContext, IAuditService } from './audit.service';

@Injectable()
export class DurableAuditService implements IAuditService {
  constructor(
    private readonly auditRepo: AuditRepo,
    private readonly cls: ClsService,
    private readonly events: EventEmitter2,
  ) {}

  async log(payload: AuditLogPayload): Promise<void> {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context?.workspaceId) await this.append(payload, context);
  }

  async logWithContext(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): Promise<void> {
    await this.append(payload, context);
  }

  async logInTransaction(
    payload: AuditLogPayload,
    trx: KyselyTransaction,
  ): Promise<void> {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context?.workspaceId)
      await this.appendInTransaction(payload, context, trx);
  }

  async logWithContextInTransaction(
    payload: AuditLogPayload,
    context: AuditLogContext,
    trx: KyselyTransaction,
  ): Promise<void> {
    await this.appendInTransaction(payload, context, trx);
  }

  async logBatchWithContext(
    payloads: AuditLogPayload[],
    context: AuditLogContext,
  ): Promise<void> {
    if (!context.workspaceId) return;
    const data = payloads.map((payload) => this.toData(payload, context));
    const entries = await this.auditRepo.appendBatch(data);
    entries.forEach((entry, index) =>
      this.events.emit('audit.appended', { ...data[index], ...entry }),
    );
  }

  setActorId(actorId: string): void {
    this.updateContext({ actorId });
  }

  setActorType(actorType: ActorType): void {
    this.updateContext({ actorType });
  }

  async updateRetention(
    workspaceId: string,
    retentionDays: number,
  ): Promise<void> {
    const days = Math.min(Math.max(retentionDays, 1), 3650);
    await this.auditRepo.removeOlderThan(
      workspaceId,
      new Date(Date.now() - days * 86_400_000),
    );
  }

  list(workspaceId: string, filter?: AuditFilter) {
    return this.auditRepo.list(workspaceId, filter);
  }

  private async append(payload: AuditLogPayload, context: AuditLogContext) {
    if (!context.workspaceId) return;
    const data = this.toData(payload, context);
    const entry = await this.auditRepo.append(data);
    this.events.emit('audit.appended', { ...data, ...entry });
  }

  private async appendInTransaction(
    payload: AuditLogPayload,
    context: AuditLogContext,
    trx: KyselyTransaction,
  ) {
    if (!context.workspaceId) return;
    await this.auditRepo.append(this.toData(payload, context), trx);
  }

  private toData(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): AuditLogData {
    return {
      ...payload,
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? undefined,
      actorType: context.actorType ?? 'user',
      ipAddress: context.ipAddress ?? undefined,
      userAgent: context.userAgent ?? undefined,
    };
  }

  private updateContext(change: Partial<AuditContext>): void {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context) this.cls.set(AUDIT_CONTEXT_KEY, { ...context, ...change });
  }
}
