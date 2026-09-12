import { AuditLogPayload, ActorType } from '../../common/events/audit-events';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';

export type AuditLogContext = {
  workspaceId: string;
  actorId?: string;
  actorType?: ActorType;
  ipAddress?: string;
  userAgent?: string;
};

export type IAuditService = {
  log(payload: AuditLogPayload): Promise<void>;
  logWithContext(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): Promise<void>;
  logInTransaction(
    payload: AuditLogPayload,
    trx: KyselyTransaction,
  ): Promise<void>;
  logWithContextInTransaction(
    payload: AuditLogPayload,
    context: AuditLogContext,
    trx: KyselyTransaction,
  ): Promise<void>;
  logBatchWithContext(
    payloads: AuditLogPayload[],
    context: AuditLogContext,
  ): Promise<void>;
  setActorId(actorId: string): void;
  setActorType(actorType: ActorType): void;
  updateRetention(
    workspaceId: string,
    retentionDays: number,
  ): Promise<void>;
};

export const AUDIT_SERVICE = Symbol('AUDIT_SERVICE');
