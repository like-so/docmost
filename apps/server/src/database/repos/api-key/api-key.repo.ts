import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '../../types/kysely.types';
import { ApiKey } from '../../types/entity.types';

@Injectable()
export class ApiKeyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  create(values: {
    name: string;
    creatorId: string;
    workspaceId: string;
    secretHash: string;
    scopes: string[];
    expiresAt?: Date;
  }) {
    return this.db
      .insertInto('apiKeys')
      .values({ ...values, expiresAt: values.expiresAt ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findActive(id: string, workspaceId: string): Promise<ApiKey | undefined> {
    return this.db
      .selectFrom('apiKeys')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  list(workspaceId: string, creatorId: string) {
    return this.db
      .selectFrom('apiKeys')
      .select([
        'id',
        'name',
        'creatorId',
        'workspaceId',
        'scopes',
        'expiresAt',
        'lastUsedAt',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', creatorId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt desc')
      .execute();
  }

  listWorkspace(workspaceId: string) {
    return this.db
      .selectFrom('apiKeys')
      .select([
        'id',
        'name',
        'creatorId',
        'workspaceId',
        'scopes',
        'expiresAt',
        'lastUsedAt',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt desc')
      .execute();
  }

  async rename(
    id: string,
    workspaceId: string,
    creatorId: string,
    name: string,
  ): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ name, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', creatorId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async renameWorkspace(
    id: string,
    workspaceId: string,
    name: string,
  ): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ name, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async setSecretHash(id: string, secretHash: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ secretHash })
      .where('id', '=', id)
      .execute();
  }

  async revoke(
    id: string,
    workspaceId: string,
    creatorId: string,
  ): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', creatorId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async revokeWorkspace(id: string, workspaceId: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async markUsed(id: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }
}
