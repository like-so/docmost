import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { UserRole } from '../../common/helpers/types/permission';
import { GroupSyncService } from './group-sync.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';

export type ScimUser = {
  userName: string;
  externalId?: string;
  name?: { formatted?: string };
  active?: boolean;
};
export type ScimGroup = {
  displayName: string;
  externalId?: string;
  members?: Array<{ value: string }>;
};

@Injectable()
export class ScimResourceService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly groups: GroupSyncService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService = {} as IAuditService,
  ) {}

  async listUsers(
    workspaceId: string,
    startIndex = 1,
    count = 100,
    filter?: string,
  ) {
    let query = this.db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'name',
        'scimExternalId',
        'deactivatedAt',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);
    const match = this.userFilter(filter);
    if (filter && !match)
      throw new BadRequestException('Unsupported SCIM filter');
    if (match?.field === 'username' || match?.field === 'email')
      query = query.where('email', '=', match.value);
    if (match?.field === 'id') query = query.where('id', '=', match.value);
    if (match?.field === 'externalid')
      query = query.where('scimExternalId', '=', match.value);
    if (match?.field === 'active')
      query = query.where(
        'deactivatedAt',
        match.value === 'true' ? 'is' : 'is not',
        null,
      );
    const [total, rows] = await Promise.all([
      query
        .clearSelect()
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      query
        .limit(Math.min(Math.max(count, 1), 100))
        .offset(Math.max(startIndex - 1, 0))
        .execute(),
    ]);
    return this.list(
      'User',
      rows.map((row) => this.user(row)),
      Number(total.count),
      startIndex,
      count,
    );
  }

  async createUser(workspaceId: string, input: ScimUser) {
    if (!input.userName) throw new BadRequestException('userName is required');
    try {
      const row = await executeTx(this.db, async (trx) => {
        const workspace = await trx
          .selectFrom('workspaces')
          .select('defaultRole')
          .where('id', '=', workspaceId)
          .executeTakeFirst();
        if (!workspace) throw new NotFoundException('Workspace not found');
        const everyone = await trx
          .selectFrom('groups')
          .select('id')
          .where('workspaceId', '=', workspaceId)
          .where('isDefault', '=', true)
          .executeTakeFirst();
        if (!everyone) throw new BadRequestException('Everyone group not found');
        const user = await trx
          .insertInto('users')
          .values({
            workspaceId,
            email: input.userName,
            name: input.name?.formatted ?? input.userName,
            password: null,
            role: workspace.defaultRole ?? UserRole.MEMBER,
            scimExternalId: input.externalId ?? null,
            deactivatedAt: input.active === false ? new Date() : null,
          })
          .returning([
            'id',
            'email',
            'name',
            'scimExternalId',
            'deactivatedAt',
            'createdAt',
            'updatedAt',
          ])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('groupUsers')
          .values({ groupId: everyone.id, userId: user.id })
          .execute();
        await trx
          .insertInto('groupMembershipSources')
          .values({
            groupId: everyone.id,
            userId: user.id,
            source: 'manual',
            providerId: '',
            createdMembership: false,
          })
          .execute();
        return user;
      });
      await this.audit(AuditEvent.USER_CREATED, workspaceId, AuditResource.USER, row.id);
      return this.user(row);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('SCIM user already exists');
      }
      throw error;
    }
  }

  async getUser(workspaceId: string, id: string) {
    const row = await this.db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'name',
        'scimExternalId',
        'deactivatedAt',
        'createdAt',
        'updatedAt',
      ])
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('SCIM user not found');
    return this.user(row);
  }

  async replaceUser(workspaceId: string, id: string, input: ScimUser) {
    await this.getUser(workspaceId, id);
    await this.db
      .updateTable('users')
      .set({
        email: input.userName,
        name: input.name?.formatted ?? input.userName,
        scimExternalId: input.externalId ?? null,
        deactivatedAt: input.active === false ? new Date() : null,
      })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
    const user = await this.getUser(workspaceId, id);
    await this.audit(
      input.active === false ? AuditEvent.USER_DEACTIVATED : AuditEvent.USER_UPDATED,
      workspaceId,
      AuditResource.USER,
      id,
    );
    return user;
  }

  async deleteUser(workspaceId: string, id: string) {
    await this.getUser(workspaceId, id);
    await this.db
      .updateTable('users')
      .set({ deactivatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .execute();
    await this.audit(AuditEvent.USER_DEACTIVATED, workspaceId, AuditResource.USER, id);
  }

  async createGroup(workspaceId: string, input: ScimGroup) {
    if (!input.displayName || !input.externalId)
      throw new BadRequestException('displayName and externalId are required');
    const ids = await this.externalIds(workspaceId, input.members ?? []);
    await this.groups.sync(workspaceId, {
      externalId: input.externalId,
      displayName: input.displayName,
      memberExternalIds: ids,
    });
    const group = await this.findGroup(workspaceId, input.externalId);
    await this.audit(AuditEvent.GROUP_CREATED, workspaceId, AuditResource.GROUP, group.id);
    return group;
  }

  async getGroup(workspaceId: string, id: string) {
    const protectedGroup = await this.defaultGroup(workspaceId, id);
    if (protectedGroup)
      throw new BadRequestException(
        'The Everyone group cannot be managed by SCIM',
      );
    const row = await this.db
      .selectFrom('groups')
      .select(['id', 'name', 'scimExternalId', 'createdAt', 'updatedAt'])
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('isExternal', '=', true)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('SCIM group not found');
    return this.group(row, await this.members(workspaceId, [row.id]));
  }

  async listGroups(
    workspaceId: string,
    startIndex = 1,
    count = 100,
    filter?: string,
  ) {
    let query = this.db
      .selectFrom('groups')
      .select(['id', 'name', 'scimExternalId', 'createdAt', 'updatedAt'])
      .where('workspaceId', '=', workspaceId)
      .where('isExternal', '=', true);
    const match = filter?.match(
      /^(displayName|id|externalId)\s+eq\s+"([^"]+)"$/i,
    );
    if (filter && !match)
      throw new BadRequestException('Unsupported SCIM filter');
    if (match?.[1].toLowerCase() === 'displayname')
      query = query.where('name', '=', match[2]);
    if (match?.[1].toLowerCase() === 'id')
      query = query.where('id', '=', match[2]);
    if (match?.[1].toLowerCase() === 'externalid')
      query = query.where('scimExternalId', '=', match[2]);
    const [total, rows] = await Promise.all([
      query
        .clearSelect()
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      query
        .limit(Math.min(Math.max(count, 1), 100))
        .offset(Math.max(startIndex - 1, 0))
        .execute(),
    ]);
    const members = await this.members(
      workspaceId,
      rows.map((row) => row.id),
    );
    return this.list(
      'Group',
      rows.map((row) => this.group(row, members)),
      Number(total.count),
      startIndex,
      count,
    );
  }

  async replaceGroup(workspaceId: string, id: string, input: ScimGroup) {
    const current = await this.getGroup(workspaceId, id);
    const externalId = input.externalId ?? current.externalId;
    if (!input.displayName || !externalId)
      throw new BadRequestException('displayName and externalId are required');
    const members = await this.externalIds(workspaceId, input.members ?? []);
    try {
      await this.groups.replace(workspaceId, id, {
        externalId,
        displayName: input.displayName,
        memberExternalIds: members,
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('SCIM group externalId already exists');
      }
      throw error;
    }
    const group = await this.getGroup(workspaceId, id);
    await this.audit(AuditEvent.GROUP_UPDATED, workspaceId, AuditResource.GROUP, id);
    return group;
  }

  async patchGroup(
    workspaceId: string,
    id: string,
    operations: Array<{ op: string; path?: string; value?: unknown }>,
  ) {
    const current = await this.getGroup(workspaceId, id);
    const rows = await this.db
      .selectFrom('groupMembershipSources')
      .innerJoin('users', 'users.id', 'groupMembershipSources.userId')
      .select(['users.id', 'users.scimExternalId'])
      .where('groupMembershipSources.groupId', '=', id)
      .where('groupMembershipSources.source', '=', 'scim')
      .where('users.workspaceId', '=', workspaceId)
      .execute();
    let members = rows.map((row) => row.id);
    let displayName = current.displayName;
    let externalId = current.externalId;
    for (const operation of operations) {
      const path = operation.path?.toLowerCase();
      if (
        operation.op.toLowerCase() === 'replace' &&
        path === 'displayname' &&
        typeof operation.value === 'string'
      )
        displayName = operation.value;
      else if (
        operation.op.toLowerCase() === 'replace' &&
        path === 'externalid' &&
        typeof operation.value === 'string'
      )
        externalId = operation.value;
      else if (path === 'members' || this.memberFilter(path)) {
        const values = Array.isArray(operation.value)
          ? (operation.value as Array<{ value: string }>)
          : [];
        const ids = values.length
          ? values.map((value) => value.value)
          : (this.memberFilter(path) ?? []);
        if (operation.op.toLowerCase() === 'replace') members = ids;
        if (operation.op.toLowerCase() === 'add')
          members = [...new Set([...members, ...ids])];
        if (operation.op.toLowerCase() === 'remove')
          members = members.filter((member) => !ids.includes(member));
      } else throw new BadRequestException('Unsupported SCIM PATCH operation');
    }
    return this.replaceGroup(workspaceId, id, {
      displayName,
      externalId,
      members: members.map((value) => ({ value })),
    });
  }

  private memberFilter(path?: string): string[] | undefined {
    const match = path?.match(
      /^members\[value\s+eq\s+["']([^"']+)["']\]$/i,
    );
    return match ? [match[1]] : undefined;
  }

  async deleteGroup(workspaceId: string, id: string): Promise<void> {
    await this.getGroup(workspaceId, id);
    await this.db
      .deleteFrom('groups')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('isExternal', '=', true)
      .execute();
    await this.audit(AuditEvent.GROUP_DELETED, workspaceId, AuditResource.GROUP, id);
  }

  private async findGroup(workspaceId: string, externalId: string) {
    const row = await this.db
      .selectFrom('groups')
      .select(['id', 'name', 'scimExternalId', 'createdAt', 'updatedAt'])
      .where('workspaceId', '=', workspaceId)
      .where('scimExternalId', '=', externalId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('SCIM group not found');
    return this.group(row, await this.members(workspaceId, [row.id]));
  }

  private userFilter(filter?: string) {
    if (!filter) return undefined;
    const match = filter.match(
      /^(userName|email|id|externalId|active)\s+eq\s+(?:"([^"]+)"|(true|false))$/i,
    );
    if (!match) return undefined;
    const field = match[1].toLowerCase();
    if (field === 'active' && !match[3]) return undefined;
    if (field !== 'active' && !match[2]) return undefined;
    return { field, value: match[2] ?? match[3] };
  }

  private async audit(
    event: (typeof AuditEvent)[keyof typeof AuditEvent],
    workspaceId: string,
    resourceType: (typeof AuditResource)[keyof typeof AuditResource],
    resourceId: string,
  ): Promise<void> {
    await this.auditService.logWithContext?.(
      { event, resourceType, resourceId, metadata: { source: 'scim' } },
      { workspaceId, actorType: 'system' },
    );
  }

  private async externalIds(
    workspaceId: string,
    members: Array<{ value: string }>,
  ) {
    if (!members.length) return [];
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'scimExternalId'])
      .where('workspaceId', '=', workspaceId)
      .where(
        'id',
        'in',
        members.map((member) => member.value),
      )
      .execute();
    if (
      users.length !== members.length ||
      users.some((user) => !user.scimExternalId)
    )
      throw new BadRequestException(
        'SCIM group members must be workspace users with externalId',
      );
    return users.map((user) => user.scimExternalId!);
  }

  private user(row: any) {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: row.id,
      externalId: row.scimExternalId,
      userName: row.email,
      name: { formatted: row.name },
      active: !row.deactivatedAt,
      meta: {
        resourceType: 'User',
        created: row.createdAt,
        lastModified: row.updatedAt,
      },
    };
  }
  private async defaultGroup(workspaceId: string, id: string) {
    return this.db
      .selectFrom('groups')
      .select('id')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('isDefault', '=', true)
      .executeTakeFirst();
  }

  private async members(workspaceId: string, groupIds: string[]) {
    if (!groupIds.length) return new Map<string, Array<{ value: string }>>();
    const rows = await this.db
      .selectFrom('groupUsers')
      .innerJoin('users', 'users.id', 'groupUsers.userId')
      .select(['groupUsers.groupId', 'users.id'])
      .where('users.workspaceId', '=', workspaceId)
      .where('groupUsers.groupId', 'in', groupIds)
      .execute();
    return rows.reduce((result, row) => {
      const values = result.get(row.groupId) ?? [];
      values.push({ value: row.id });
      result.set(row.groupId, values);
      return result;
    }, new Map<string, Array<{ value: string }>>());
  }

  private group(
    row: any,
    members = new Map<string, Array<{ value: string }>>(),
  ) {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      id: row.id,
      externalId: row.scimExternalId,
      displayName: row.name,
      members: members.get(row.id) ?? [],
      meta: {
        resourceType: 'Group',
        created: row.createdAt,
        lastModified: row.updatedAt,
      },
    };
  }
  private list(
    resourceType: string,
    resources: unknown[],
    totalResults: number,
    startIndex: number,
    itemsPerPage: number,
  ) {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults,
      startIndex,
      itemsPerPage,
      Resources: resources,
      resourceType,
    };
  }
}
