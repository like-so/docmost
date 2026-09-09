import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  AuthAccount,
  AuthProvider,
  InsertableAuthProvider,
  UpdatableAuthProvider,
} from '@docmost/db/types/entity.types';

@Injectable()
export class AuthProviderRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async create(provider: InsertableAuthProvider): Promise<AuthProvider> {
    return this.db
      .insertInto('authProviders')
      .values(provider)
      .returningAll()
      .executeTakeFirst();
  }

  async findById(id: string, workspaceId: string): Promise<AuthProvider> {
    return this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async list(workspaceId: string): Promise<AuthProvider[]> {
    return this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  async listEnabled(workspaceId: string): Promise<AuthProvider[]> {
    return this.db
      .selectFrom('authProviders')
      .select(['id', 'name', 'type', 'isEnabled'])
      .where('workspaceId', '=', workspaceId)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute() as Promise<AuthProvider[]>;
  }

  async findEnabled(id: string, workspaceId: string): Promise<AuthProvider> {
    return this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async linkAccount(
    workspaceId: string,
    providerId: string,
    userId: string,
    providerUserId: string,
  ): Promise<AuthAccount | undefined> {
    return this.db
      .insertInto('authAccounts')
      .values({
        workspaceId,
        authProviderId: providerId,
        userId,
        providerUserId,
      })
      .onConflict((conflict) =>
        conflict.columns(['authProviderId', 'providerUserId']).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  async update(
    id: string,
    workspaceId: string,
    provider: UpdatableAuthProvider,
  ): Promise<AuthProvider> {
    return this.db
      .updateTable('authProviders')
      .set({ ...provider, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    await this.db
      .updateTable('authProviders')
      .set({ deletedAt: new Date(), isEnabled: false })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }
}
