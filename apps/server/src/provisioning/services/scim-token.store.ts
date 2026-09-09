import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  NewScimToken,
  ScimTokenRecord,
  ScimTokenStore,
} from '../ports/scim-token.store';

@Injectable()
export class KyselyScimTokenStore implements ScimTokenStore {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async create(token: NewScimToken): Promise<ScimTokenRecord> {
    return this.db
      .insertInto('scimTokens')
      .values(token)
      .returning(['id', 'name', 'tokenLastFour', 'isEnabled', 'createdAt'])
      .executeTakeFirstOrThrow();
  }

  async findActiveByHash(
    tokenHash: string,
  ): Promise<ScimTokenRecord | undefined> {
    return this.db
      .selectFrom('scimTokens')
      .select(['id', 'workspaceId', 'isEnabled'])
      .where('tokenHash', '=', tokenHash)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async markUsed(id: string): Promise<void> {
    await this.db
      .updateTable('scimTokens')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async revoke(id: string, workspaceId: string): Promise<void> {
    await this.db
      .updateTable('scimTokens')
      .set({ isEnabled: false })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async list(workspaceId: string): Promise<ScimTokenRecord[]> {
    return this.db
      .selectFrom('scimTokens')
      .select(['id', 'name', 'tokenLastFour', 'isEnabled', 'createdAt'])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }
}
