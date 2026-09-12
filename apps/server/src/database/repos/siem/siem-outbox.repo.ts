import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';

@Injectable()
export class SiemOutboxRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async createForAudit(
    auditId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const database = dbOrTx(this.db, trx);
    const destinations = await database
      .selectFrom('siemDestinations')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', true)
      .execute();
    if (!destinations.length) return;
    await database
      .insertInto('siemDeliveryOutbox')
      .values(
        destinations.map((destination) => ({
          destinationId: destination.id,
          auditId,
          workspaceId,
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(['destinationId', 'auditId']).doNothing(),
      )
      .execute();
  }

  next(destinationId: string) {
    return this.db
      .selectFrom('siemDeliveryOutbox')
      .select(['id', 'auditId'])
      .where('destinationId', '=', destinationId)
      .where('deliveredAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirst();
  }

  async markDelivered(id: string): Promise<void> {
    await this.db
      .updateTable('siemDeliveryOutbox')
      .set({ deliveredAt: new Date() })
      .where('id', '=', id)
      .where('deliveredAt', 'is', null)
      .execute();
  }
}
