import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { AuditLogData } from '../../../common/events/audit-events';
import { SiemOutboxRepo } from '../siem/siem-outbox.repo';

export type AuditFilter = {
  event?: string;
  actorId?: string;
  resourceType?: string;
  cursor?: string;
  limit?: number;
};

@Injectable()
export class AuditRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly outbox: SiemOutboxRepo,
  ) {}

  async append(data: AuditLogData, trx?: KyselyTransaction) {
    return executeTx(
      this.db,
      (transaction) => this.appendWithTx(data, transaction),
      trx,
    );
  }

  async appendBatch(data: AuditLogData[], trx?: KyselyTransaction) {
    if (!data.length) return [];
    return executeTx(
      this.db,
      (transaction) => this.appendBatchWithTx(data, transaction),
      trx,
    );
  }

  private async appendWithTx(data: AuditLogData, trx: KyselyTransaction) {
    const entry = await dbOrTx(this.db, trx)
      .insertInto('audit')
      .values(data)
      .returning(['id', 'createdAt'])
      .executeTakeFirstOrThrow();
    await this.outbox.createForAudit(entry.id, data.workspaceId, trx);
    return entry;
  }

  private async appendBatchWithTx(
    data: AuditLogData[],
    trx: KyselyTransaction,
  ) {
    const entries = await dbOrTx(this.db, trx)
      .insertInto('audit')
      .values(data)
      .returning(['id', 'createdAt'])
      .execute();
    await Promise.all(
      entries.map((entry, index) =>
        this.outbox.createForAudit(entry.id, data[index]!.workspaceId, trx),
      ),
    );
    return entries;
  }

  async list(workspaceId: string, filter: AuditFilter = {}) {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return this.db
      .selectFrom('audit')
      .selectAll()
      .$if(!!filter.event, (qb) => qb.where('event', '=', filter.event!))
      .$if(!!filter.actorId, (qb) => qb.where('actorId', '=', filter.actorId!))
      .$if(!!filter.resourceType, (qb) =>
        qb.where('resourceType', '=', filter.resourceType!),
      )
      .$if(!!filter.cursor, (qb) => qb.where('id', '<', filter.cursor!))
      .where('workspaceId', '=', workspaceId)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  findById(id: string, workspaceId: string) {
    return this.db
      .selectFrom('audit')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  listForDelivery(
    workspaceId: string,
    cursor?: { createdAt: Date; id: string },
    limit = 100,
  ) {
    return this.db
      .selectFrom('audit')
      .select(['id', 'createdAt'])
      .where('workspaceId', '=', workspaceId)
      .$if(!!cursor, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('createdAt', '>', cursor!.createdAt),
            eb.and([
              eb('createdAt', '=', cursor!.createdAt),
              eb('id', '>', cursor!.id),
            ]),
          ]),
        ),
      )
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
  }

  async findNextForDelivery(
    workspaceId: string,
    cursor?: { createdAt: Date; id: string },
  ) {
    return (await this.listForDelivery(workspaceId, cursor, 1))[0];
  }

  async removeOlderThan(workspaceId: string, cutoff: Date): Promise<void> {
    await this.db
      .deleteFrom('audit')
      .where('workspaceId', '=', workspaceId)
      .where('createdAt', '<', cutoff)
      .execute();
  }
}
