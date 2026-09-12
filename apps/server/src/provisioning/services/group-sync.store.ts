import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { ExternalGroup, GroupSyncStore } from '../ports/group-sync.store';

type Source = 'manual' | 'scim' | 'sso';
type Membership = { groupId: string; userId: string };

@Injectable()
export class KyselyGroupSyncStore implements GroupSyncStore {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async syncUserGroups(
    workspaceId: string,
    userId: string,
    providerId: string,
    groupNames: string[],
  ): Promise<void> {
    await executeTx(this.db, async (trx) => {
      const groups = await this.findNamedGroups(trx, workspaceId, groupNames);
      const blocked = await this.scimGroups(
        trx,
        userId,
        groups.map((group) => group.id),
      );
      const desired = groups
        .filter((group) => !group.isDefault && !blocked.has(group.id))
        .map((group) => ({ groupId: group.id, userId }));
      await this.replaceSource(trx, userId, 'sso', providerId, desired);
    });
  }

  async syncGroup(workspaceId: string, group: ExternalGroup): Promise<void> {
    await executeTx(this.db, async (trx) => {
      const saved = await this.upsertScimGroup(trx, workspaceId, group);
      if (saved.isDefault) {
        throw new BadRequestException(
          'The Everyone group cannot be managed by SCIM',
        );
      }
      const users = await this.findScimUsers(
        trx,
        workspaceId,
        group.memberExternalIds,
      );
      if (users.length !== group.memberExternalIds.length) {
        throw new BadRequestException(
          'SCIM group references users outside this workspace',
        );
      }
      await this.replaceSource(
        trx,
        undefined,
        'scim',
        '',
        users.map((user) => ({ groupId: saved.id, userId: user.id })),
        saved.id,
      );
    });
  }

  async replaceGroup(
    workspaceId: string,
    groupId: string,
    group: ExternalGroup,
  ): Promise<void> {
    await executeTx(this.db, async (trx) => {
      const saved = await this.findScimGroup(trx, workspaceId, groupId);
      if (saved.isDefault) {
        throw new BadRequestException(
          'The Everyone group cannot be managed by SCIM',
        );
      }
      const collision = await trx
        .selectFrom('groups')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .where('scimExternalId', '=', group.externalId)
        .where('id', '!=', groupId)
        .executeTakeFirst();
      if (collision)
        throw new BadRequestException('SCIM group externalId already exists');
      const users = await this.findScimUsers(
        trx,
        workspaceId,
        group.memberExternalIds,
      );
      if (users.length !== group.memberExternalIds.length) {
        throw new BadRequestException(
          'SCIM group references users outside this workspace',
        );
      }
      await trx
        .updateTable('groups')
        .set({
          name: group.displayName,
          scimExternalId: group.externalId,
          isExternal: true,
          updatedAt: new Date(),
        })
        .where('id', '=', groupId)
        .where('workspaceId', '=', workspaceId)
        .execute();
      await this.replaceSource(
        trx,
        undefined,
        'scim',
        '',
        users.map((user) => ({ groupId, userId: user.id })),
        groupId,
      );
    });
  }

  private async findNamedGroups(
    trx: KyselyDB,
    workspaceId: string,
    names: string[],
  ) {
    const wanted = [
      ...new Set(
        names.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean),
      ),
    ];
    if (!wanted.length) return [];
    return trx
      .selectFrom('groups')
      .select(['id', 'isDefault'])
      .where('workspaceId', '=', workspaceId)
      .where('isExternal', '=', false)
      .where(sql`lower(name)`, 'in', wanted)
      .execute();
  }

  private async scimGroups(trx: KyselyDB, userId: string, groupIds: string[]) {
    if (!groupIds.length) return new Set<string>();
    const rows = await trx
      .selectFrom('groupMembershipSources')
      .select('groupId')
      .where('userId', '=', userId)
      .where('source', '=', 'scim')
      .where('groupId', 'in', groupIds)
      .execute();
    return new Set(rows.map((row) => row.groupId));
  }

  private async upsertScimGroup(
    trx: KyselyDB,
    workspaceId: string,
    group: ExternalGroup,
  ) {
    const existing = await trx
      .selectFrom('groups')
      .select(['id', 'isDefault'])
      .where('workspaceId', '=', workspaceId)
      .where('scimExternalId', '=', group.externalId)
      .executeTakeFirst();
    if (existing) {
      await trx
        .updateTable('groups')
        .set({
          name: group.displayName,
          isExternal: true,
          updatedAt: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
      return existing;
    }
    return trx
      .insertInto('groups')
      .values({
        workspaceId,
        name: group.displayName,
        scimExternalId: group.externalId,
        isExternal: true,
        isDefault: false,
      })
      .returning(['id', 'isDefault'])
      .executeTakeFirstOrThrow();
  }

  private async findScimGroup(
    trx: KyselyDB,
    workspaceId: string,
    groupId: string,
  ) {
    const group = await trx
      .selectFrom('groups')
      .select(['id', 'isDefault'])
      .where('id', '=', groupId)
      .where('workspaceId', '=', workspaceId)
      .where('isExternal', '=', true)
      .executeTakeFirst();
    if (!group) throw new NotFoundException('SCIM group not found');
    return group;
  }

  private async findScimUsers(
    trx: KyselyDB,
    workspaceId: string,
    externalIds: string[],
  ) {
    if (!externalIds.length) return [];
    return trx
      .selectFrom('users')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('scimExternalId', 'in', externalIds)
      .execute();
  }

  private async replaceSource(
    trx: KyselyDB,
    userId: string | undefined,
    source: Source,
    providerId: string,
    desired: Membership[],
    groupId?: string,
  ): Promise<void> {
    const current = await this.sourceRows(trx, userId, source, providerId, groupId);
    const desiredKeys = new Set(desired.map(this.key));
    for (const row of current) {
      if (!desiredKeys.has(this.key(row)))
        await this.removeSource(trx, row, source, providerId);
    }
    const currentKeys = new Set(current.map(this.key));
    for (const membership of desired) {
      if (!currentKeys.has(this.key(membership)))
        await this.addSource(trx, membership, source, providerId);
    }
  }

  private async sourceRows(
    trx: KyselyDB,
    userId: string | undefined,
    source: Source,
    providerId: string,
    groupId?: string,
  ) {
    let query = trx
      .selectFrom('groupMembershipSources')
      .select(['groupId', 'userId', 'createdMembership'])
      .where('source', '=', source)
      .where('providerId', '=', providerId);
    if (source === 'sso') {
      query = query
        .innerJoin('groups', 'groups.id', 'groupMembershipSources.groupId')
        .where('groups.isExternal', '=', false);
    }
    if (userId) query = query.where('userId', '=', userId);
    if (groupId) query = query.where('groupId', '=', groupId);
    return query.execute();
  }

  private async addSource(
    trx: KyselyDB,
    membership: Membership,
    source: Source,
    providerId: string,
  ) {
    if (source === 'scim') {
      const sso = await trx
        .selectFrom('groupMembershipSources')
        .select(['groupId', 'userId', 'createdMembership', 'providerId'])
        .where('groupId', '=', membership.groupId)
        .where('userId', '=', membership.userId)
        .where('source', '=', 'sso')
        .execute();
      for (const entry of sso) {
        await this.removeSource(trx, entry, 'sso', entry.providerId);
      }
    }
    const existing = await trx
      .selectFrom('groupUsers')
      .select('id')
      .where('groupId', '=', membership.groupId)
      .where('userId', '=', membership.userId)
      .executeTakeFirst();
    if (!existing)
      await trx.insertInto('groupUsers').values(membership).execute();
    const manual = existing
      ? await trx
          .selectFrom('groupMembershipSources')
          .select('id')
          .where('groupId', '=', membership.groupId)
          .where('userId', '=', membership.userId)
          .where('source', '=', 'manual')
          .executeTakeFirst()
      : undefined;
    await trx
      .insertInto('groupMembershipSources')
      .values({
        ...membership,
        source,
        providerId,
        createdMembership: source !== 'manual' && !manual,
      })
      .execute();
  }

  private async removeSource(
    trx: KyselyDB,
    membership: Membership & { createdMembership: boolean },
    source: Source,
    providerId: string,
  ) {
    await trx
      .deleteFrom('groupMembershipSources')
      .where('groupId', '=', membership.groupId)
      .where('userId', '=', membership.userId)
      .where('source', '=', source)
      .where('providerId', '=', providerId)
      .execute();
    if (!membership.createdMembership) return;
    const remaining = await trx
      .selectFrom('groupMembershipSources')
      .select('id')
      .where('groupId', '=', membership.groupId)
      .where('userId', '=', membership.userId)
      .executeTakeFirst();
    if (!remaining) {
      await trx
        .deleteFrom('groupUsers')
        .where('groupId', '=', membership.groupId)
        .where('userId', '=', membership.userId)
        .execute();
    }
  }

  private key(membership: Membership): string {
    return `${membership.groupId}:${membership.userId}`;
  }
}
