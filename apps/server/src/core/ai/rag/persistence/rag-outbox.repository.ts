import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { IndexRequest, InputRevision, parseIndexRequest } from '../contracts';

/**
 * Durable outbox of IndexRequests. Inserts are idempotent on the eventId
 * primary key; acknowledgement happens only after an accepted queue enqueue.
 */
@Injectable()
export class RagOutboxRepository {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /** Insert a request; a duplicate eventId is a no-op. Returns true when inserted. */
  async insert(
    db: KyselyDB | KyselyTransaction,
    request: IndexRequest,
  ): Promise<boolean> {
    const rows = await db
      .insertInto('ragOutbox')
      .values({
        id: request.eventId,
        workspaceId: request.key.workspaceId,
        pageId: request.key.pageId,
        inputRevision: request.inputRevision,
        operation: request.operation,
        cause: request.cause,
        schemaVersion: request.schemaVersion,
        occurredAt: new Date(request.occurredAt),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  async pending(
    db: KyselyDB | KyselyTransaction,
    limit: number,
  ): Promise<IndexRequest[]> {
    const rows = await db
      .selectFrom('ragOutbox')
      .selectAll()
      .where('status', '=', 'pending')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => this.toIndexRequest(row));
  }

  /** Acknowledge delivery; only a pending record can be marked delivered. */
  async markDelivered(
    db: KyselyDB | KyselyTransaction,
    eventId: string,
  ): Promise<boolean> {
    const result = await db
      .updateTable('ragOutbox')
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where('id', '=', eventId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Record a failed delivery attempt with a redacted error code. */
  async markDeliveryFailed(
    db: KyselyDB | KyselyTransaction,
    eventId: string,
    errorCode: string,
  ): Promise<void> {
    await db
      .updateTable('ragOutbox')
      .set({
        attempts: sql`rag_outbox.attempts + 1`,
        lastErrorCode: errorCode,
      })
      .where('id', '=', eventId)
      .where('status', '=', 'pending')
      .execute();
  }

  private toIndexRequest(row: {
    id: string;
    workspaceId: string;
    pageId: string;
    inputRevision: string;
    operation: string;
    cause: string;
    schemaVersion: number;
    occurredAt: Date;
  }): IndexRequest {
    return parseIndexRequest({
      schemaVersion: row.schemaVersion,
      eventId: row.id,
      key: { workspaceId: row.workspaceId, pageId: row.pageId },
      inputRevision: row.inputRevision as InputRevision,
      operation: row.operation,
      cause: row.cause,
      occurredAt: row.occurredAt.toISOString(),
    });
  }
}
