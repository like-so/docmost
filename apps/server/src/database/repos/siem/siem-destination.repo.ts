import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Insertable, Selectable, Updateable } from 'kysely';
import { SiemDestinations } from '@docmost/db/types/db';

export type SiemDestination = Selectable<SiemDestinations>;
export type NewSiemDestination = Insertable<SiemDestinations>;
export type SiemUpdate = Updateable<SiemDestinations>;

@Injectable()
export class SiemDestinationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  create(data: NewSiemDestination): Promise<SiemDestination> {
    return this.db
      .insertInto('siemDestinations')
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  list(workspaceId: string): Promise<SiemDestination[]> {
    return this.db
      .selectFrom('siemDestinations')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  listEnabled(): Promise<SiemDestination[]> {
    return this.db
      .selectFrom('siemDestinations')
      .selectAll()
      .where('enabled', '=', true)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  findById(id: string): Promise<SiemDestination | undefined> {
    return this.db
      .selectFrom('siemDestinations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async update(
    id: string,
    workspaceId: string,
    data: SiemUpdate,
  ): Promise<SiemDestination> {
    return this.db
      .updateTable('siemDestinations')
      .set({ ...data, version: sql`version + 1`, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    await this.db
      .deleteFrom('siemDestinations')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async recordFailure(
    id: string,
    message: string,
  ): Promise<Pick<SiemDestination, 'consecutiveFailures'>> {
    return this.db
      .updateTable('siemDestinations')
      .set({
        consecutiveFailures: sql`consecutive_failures + 1`,
        status: 'failing',
        lastError: message.slice(0, 1024),
        lastErrorAt: new Date(),
        failingSince: sql`COALESCE(failing_since, now())`,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .returning('consecutiveFailures')
      .executeTakeFirstOrThrow();
  }

  async disable(id: string): Promise<void> {
    await this.db
      .updateTable('siemDestinations')
      .set({ enabled: false, status: 'disabled', updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async markDelivered(
    id: string,
    cursorCreatedAt: Date,
    cursorId: string,
  ): Promise<void> {
    await this.db
      .updateTable('siemDestinations')
      .set({
        cursorCreatedAt,
        cursorId,
        consecutiveFailures: 0,
        status: 'healthy',
        nextAttemptAt: null,
        lastDeliveredAt: new Date(),
        lastError: null,
        lastErrorAt: null,
        failingSince: null,
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .where((eb) =>
        eb.or([
          eb('cursorCreatedAt', 'is', null),
          eb('cursorCreatedAt', '<', cursorCreatedAt),
          eb.and([
            eb('cursorCreatedAt', '=', cursorCreatedAt),
            eb('cursorId', '<', cursorId),
          ]),
        ]),
      )
      .execute();
  }
}
