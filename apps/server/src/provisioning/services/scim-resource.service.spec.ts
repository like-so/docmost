import { BadRequestException, ConflictException } from '@nestjs/common';
import { ScimResourceService } from './scim-resource.service';

describe('ScimResourceService user creation errors', () => {
  const execute = jest.fn();
  const tx = {
    selectFrom: jest.fn((table: string) => {
      const query = {
        where: jest.fn(function () {
          return this;
        }),
        executeTakeFirst: async () =>
          table === 'workspaces'
            ? { defaultRole: 'member' }
            : { id: 'everyone' },
      };
      return { select: () => query };
    }),
    insertInto: jest.fn((table: string) => ({
      values: () =>
        table === 'users'
          ? { returning: () => ({ executeTakeFirstOrThrow: execute }) }
          : { execute: jest.fn() },
    })),
  };
  const db = {
    transaction: () => ({
      execute: (callback: (trx: unknown) => unknown) => callback(tx),
    }),
  };
  const service = new ScimResourceService(db as any, {} as any);
  beforeEach(() => jest.clearAllMocks());
  it('maps only unique constraint failures to conflict', async () => {
    execute.mockRejectedValue({ code: '23505' });
    await expect(
      service.createUser('workspace', { userName: 'a@example.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('preserves infrastructure failures', async () => {
    const error = new Error('database unavailable');
    execute.mockRejectedValue(error);
    await expect(
      service.createUser('workspace', { userName: 'a@example.com' }),
    ).rejects.toBe(error);
  });
});

describe('ScimResourceService user provisioning lifecycle', () => {
  const user = {
    id: 'user-id',
    email: 'person@example.com',
    name: 'Person',
    scimExternalId: 'directory-id',
    deactivatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function database(options?: {
    defaultRole?: string | null;
    workspace?: boolean;
    everyone?: boolean;
    fail?: Error;
    membershipFail?: Error;
  }) {
    const defaultRole =
      options && 'defaultRole' in options ? options.defaultRole : 'admin';
    const users = jest.fn().mockReturnValue({
      returning: () => ({
        executeTakeFirstOrThrow: async () => {
          if (options?.fail) throw options.fail;
          return user;
        },
      }),
    });
    const memberships = jest.fn().mockReturnValue({
      execute: async () => {
        if (options?.membershipFail) throw options.membershipFail;
      },
    });
    const sources = jest.fn().mockReturnValue({ execute: jest.fn() });
    const tx = {
      selectFrom: jest.fn((table: string) => {
        const value =
          table === 'workspaces'
            ? options?.workspace === false
              ? undefined
              : { defaultRole }
            : options?.everyone === false
              ? undefined
              : { id: 'everyone-id' };
        const query = {
          where: jest.fn(function () {
            return this;
          }),
          executeTakeFirst: jest.fn().mockResolvedValue(value),
        };
        return { select: jest.fn(() => query) };
      }),
      insertInto: jest.fn((table: string) => ({
        values:
          table === 'users'
            ? users
            : table === 'groupUsers'
              ? memberships
              : sources,
      })),
    };
    const rollback = jest.fn();
    const db = {
      transaction: () => ({
        execute: async (callback: (trx: unknown) => unknown) => {
          try {
            return await callback(tx);
          } catch (error) {
            rollback(error);
            throw error;
          }
        },
      }),
    };
    return { db, memberships, rollback, sources, tx, users };
  }

  it('assigns the workspace role and immutable Everyone membership atomically', async () => {
    const fixture = database();
    const service = new ScimResourceService(fixture.db as any, {} as any);

    await service.createUser('workspace-id', {
      userName: 'person@example.com',
      externalId: 'directory-id',
      name: { formatted: 'Person' },
    });

    expect(fixture.users).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'admin', workspaceId: 'workspace-id' }),
    );
    expect(fixture.memberships).toHaveBeenCalledWith({
      groupId: 'everyone-id',
      userId: 'user-id',
    });
    expect(fixture.sources).toHaveBeenCalledWith({
      groupId: 'everyone-id',
      userId: 'user-id',
      source: 'manual',
      providerId: '',
      createdMembership: false,
    });
  });

  it('falls back to member when a legacy workspace has no default role', async () => {
    const fixture = database({ defaultRole: null });
    const service = new ScimResourceService(fixture.db as any, {} as any);

    await service.createUser('workspace-id', { userName: 'person@example.com' });

    expect(fixture.users).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'member' }),
    );
  });

  it('rolls back user provisioning when its membership cannot be created', async () => {
    const fixture = database({
      membershipFail: new Error('membership unavailable'),
    });
    const service = new ScimResourceService(fixture.db as any, {} as any);

    await expect(
      service.createUser('workspace-id', { userName: 'person@example.com' }),
    ).rejects.toThrow('membership unavailable');

    expect(fixture.rollback).toHaveBeenCalled();
  });

  it('does not create a cross-workspace user when the workspace is missing', async () => {
    const fixture = database({ workspace: false });
    const service = new ScimResourceService(fixture.db as any, {} as any);

    await expect(
      service.createUser('other-workspace', { userName: 'person@example.com' }),
    ).rejects.toMatchObject({ message: 'Workspace not found' });

    expect(fixture.users).not.toHaveBeenCalled();
  });

  it('reactivates without changing the role or default-group membership', async () => {
    const updated = {
      set: jest.fn(function () {
        return this;
      }),
      where: jest.fn(function () {
        return this;
      }),
      execute: jest.fn(),
    };
    const service = new ScimResourceService(
      { updateTable: jest.fn(() => updated) } as any,
      {} as any,
    );
    jest.spyOn(service, 'getUser').mockResolvedValue(user as any);

    await service.replaceUser('workspace-id', 'user-id', {
      userName: 'person@example.com',
      active: true,
    });

    expect(updated.set).toHaveBeenCalledWith(
      expect.not.objectContaining({ role: expect.anything() }),
    );
  });
});

describe('ScimResourceService group responses', () => {
  const groups = { replace: jest.fn() };
  const service = new ScimResourceService({} as any, groups as any);

  beforeEach(() => jest.clearAllMocks());

  it('includes SCIM member values and pre-pagination totals', () => {
    const members = new Map([['group-id', [{ value: 'user-id' }]]]);
    expect(
      (service as any).group(
        { id: 'group-id', name: 'Engineering', scimExternalId: 'eng' },
        members,
      ),
    ).toMatchObject({
      id: 'group-id',
      members: [{ value: 'user-id' }],
    });
    expect(
      (service as any).list('Group', [{ id: 'group-id' }], 4, 3, 1),
    ).toMatchObject({
      totalResults: 4,
      startIndex: 3,
      itemsPerPage: 1,
    });
  });

  it('updates the addressed group identity when externalId changes', async () => {
    jest
      .spyOn(service as any, 'getGroup')
      .mockResolvedValueOnce({
        id: 'group-id',
        externalId: 'before',
        displayName: 'Before',
      })
      .mockResolvedValueOnce({
        id: 'group-id',
        externalId: 'after',
        displayName: 'After',
      });
    jest
      .spyOn(service as any, 'externalIds')
      .mockResolvedValue(['user-external-id']);
    groups.replace.mockResolvedValue(undefined);

    await expect(
      service.replaceGroup('workspace-id', 'group-id', {
        displayName: 'After',
        externalId: 'after',
        members: [{ value: 'user-id' }],
      }),
    ).resolves.toMatchObject({ id: 'group-id', externalId: 'after' });
    expect(groups.replace).toHaveBeenCalledWith(
      'workspace-id',
      'group-id',
      {
        externalId: 'after',
        displayName: 'After',
        memberExternalIds: ['user-external-id'],
      },
    );
  });

  it('rejects externalId collisions without creating a second group', async () => {
    jest.spyOn(service as any, 'getGroup').mockResolvedValue({
      id: 'group-id',
      externalId: 'before',
      displayName: 'Before',
    });
    jest.spyOn(service as any, 'externalIds').mockResolvedValue([]);
    groups.replace.mockRejectedValue({ code: '23505' });

    await expect(
      service.replaceGroup('workspace-id', 'group-id', {
        displayName: 'After',
        externalId: 'taken',
        members: [],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('patches only SCIM-owned memberships, leaving manual edges unclaimed', async () => {
    const execute = jest.fn().mockResolvedValue([
      { id: 'scim-keep', scimExternalId: 'external-keep' },
      { id: 'scim-remove', scimExternalId: 'external-remove' },
    ]);
    const db = {
      selectFrom: jest.fn(() => ({
        innerJoin: () => ({
          select: () => ({
            where: () => ({
              where: () => ({ where: () => ({ execute }) }),
            }),
          }),
        }),
      })),
    };
    const replace = jest.fn().mockResolvedValue({ id: 'group-id' });
    const scoped = new ScimResourceService(db as any, groups as any);
    jest.spyOn(scoped as any, 'getGroup').mockResolvedValue({
      id: 'group-id',
      externalId: 'eng',
      displayName: 'Engineering',
    });
    jest.spyOn(scoped as any, 'replaceGroup').mockImplementation(replace);

    await scoped.patchGroup('workspace-id', 'group-id', [
      {
        op: 'remove',
        path: 'members',
        value: [{ value: 'scim-remove' }],
      },
    ]);

    expect(db.selectFrom).toHaveBeenCalledWith('groupMembershipSources');
    expect(replace).toHaveBeenCalledWith('workspace-id', 'group-id', {
      displayName: 'Engineering',
      externalId: 'eng',
      members: [{ value: 'scim-keep' }],
    });
  });

  it('supports filtered member removal used by SCIM clients', async () => {
    const execute = jest.fn().mockResolvedValue([
      { id: 'scim-keep', scimExternalId: 'external-keep' },
      { id: 'scim-remove', scimExternalId: 'external-remove' },
    ]);
    const db = { selectFrom: jest.fn(() => ({ innerJoin: () => ({ select: () => ({ where: () => ({ where: () => ({ where: () => ({ execute }) }) }) }) }) })) };
    const scoped = new ScimResourceService(db as any, groups as any);
    jest.spyOn(scoped as any, 'getGroup').mockResolvedValue({ id: 'group-id', externalId: 'eng', displayName: 'Engineering' });
    const replace = jest.spyOn(scoped as any, 'replaceGroup').mockResolvedValue({ id: 'group-id' });

    await scoped.patchGroup('workspace-id', 'group-id', [{
      op: 'remove', path: 'members[value eq "scim-remove"]',
    }]);

    expect(replace).toHaveBeenCalledWith('workspace-id', 'group-id', expect.objectContaining({
      members: [{ value: 'scim-keep' }],
    }));
  });

  it('clears all SCIM-owned members for remove members without a value', async () => {
    const execute = jest.fn().mockResolvedValue([
      { id: 'scim-one', scimExternalId: 'external-one' },
    ]);
    const db = { selectFrom: jest.fn(() => ({ innerJoin: () => ({ select: () => ({ where: () => ({ where: () => ({ where: () => ({ execute }) }) }) }) }) })) };
    const scoped = new ScimResourceService(db as any, groups as any);
    jest.spyOn(scoped as any, 'getGroup').mockResolvedValue({ id: 'group-id', externalId: 'eng', displayName: 'Engineering' });
    const replace = jest.spyOn(scoped as any, 'replaceGroup').mockResolvedValue({ id: 'group-id' });

    await scoped.patchGroup('workspace-id', 'group-id', [{ op: 'remove', path: 'members' }]);

    expect(replace).toHaveBeenCalledWith('workspace-id', 'group-id', expect.objectContaining({
      members: [],
    }));
  });

  it('rejects unsupported group patch operations', async () => {
    await expect(
      service.patchGroup('workspace-id', 'group-id', [
        { op: 'replace', path: 'unknown', value: 'value' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ScimResourceService user patching', () => {
  const service = new ScimResourceService({} as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('merges a pathless replace into supported user fields', async () => {
    jest.spyOn(service, 'getUser').mockResolvedValue({
      userName: 'before@example.com',
      externalId: 'before-id',
      active: true,
      name: { formatted: 'Before' },
    } as any);
    const replace = jest.spyOn(service, 'replaceUser').mockResolvedValue({} as any);

    await service.patchUser('workspace-id', 'user-id', [
      {
        op: 'replace',
        value: { active: false, name: { formatted: 'After' } },
      },
    ]);

    expect(replace).toHaveBeenCalledWith('workspace-id', 'user-id', {
      userName: 'before@example.com',
      externalId: 'before-id',
      active: false,
      name: { formatted: 'After' },
    });
  });

  it('rejects unsupported user patch operations', async () => {
    jest.spyOn(service, 'getUser').mockResolvedValue({
      userName: 'person@example.com',
    } as any);

    await expect(
      service.patchUser('workspace-id', 'user-id', [
        { op: 'add', path: 'userName', value: 'person@example.com' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ScimResourceService pagination', () => {
  const service = new ScimResourceService({} as any, {} as any);

  it('normalizes effective pagination and reports returned rows', () => {
    expect((service as any).pagination(NaN, 0)).toEqual({
      startIndex: 1,
      count: 0,
    });
    expect((service as any).pagination(2.5, Infinity)).toEqual({
      startIndex: 1,
      count: 100,
    });
    expect((service as any).list('User', [], 4, 1, 0)).toMatchObject({
      startIndex: 1,
      itemsPerPage: 0,
    });
  });

  it('orders user pages by ID and permits an explicit zero limit', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const count = { executeTakeFirstOrThrow: jest.fn().mockResolvedValue({ count: 4 }) };
    const query = {
      select: jest.fn(function () {
        return this;
      }),
      where: jest.fn(function () {
        return this;
      }),
      orderBy: jest.fn(function () {
        return this;
      }),
      limit: jest.fn(function () {
        return this;
      }),
      offset: jest.fn(function () {
        return this;
      }),
      execute,
      clearSelect: jest.fn(() => ({ select: jest.fn(() => count) })),
    };
    const paged = new ScimResourceService(
      { selectFrom: jest.fn(() => query) } as any,
      {} as any,
    );

    await expect(paged.listUsers('workspace-id', 0, 0)).resolves.toMatchObject({
      startIndex: 1,
      itemsPerPage: 0,
    });

    expect(query.orderBy).toHaveBeenCalledWith('id asc');
    expect(query.limit).toHaveBeenCalledWith(0);
  });
});

describe('ScimResourceService documented user filters', () => {
  const service = new ScimResourceService({} as any, {} as any);

  it.each([
    ['userName eq "person@example.com"', 'username', 'person@example.com'],
    ['email eq "person@example.com"', 'email', 'person@example.com'],
    ['id eq "user-id"', 'id', 'user-id'],
    ['externalId eq "directory-id"', 'externalid', 'directory-id'],
    ['active eq true', 'active', 'true'],
    ['active eq false', 'active', 'false'],
  ])('parses %s', (filter, field, value) => {
    expect((service as any).userFilter(filter)).toEqual({ field, value });
  });

  it('rejects unsupported and malformed filters', () => {
    expect((service as any).userFilter('active eq "true"')).toBeUndefined();
    expect((service as any).userFilter('name co "person"')).toBeUndefined();
  });
});

describe('ScimResourceService deprovisioning', () => {
  it('deactivates a user without deleting its account', async () => {
    const selected = {
      select: jest.fn(function () {
        return this;
      }),
      where: jest.fn(function () {
        return this;
      }),
      executeTakeFirst: jest.fn().mockResolvedValue({
        id: 'user-id',
        email: 'person@example.com',
      }),
    };
    const updated = {
      set: jest.fn(function () {
        return this;
      }),
      where: jest.fn(function () {
        return this;
      }),
      execute: jest.fn(),
    };
    const db = {
      selectFrom: jest.fn(() => selected),
      updateTable: jest.fn(() => updated),
      deleteFrom: jest.fn(),
    };
    const service = new ScimResourceService(db as any, {} as any);

    await service.deleteUser('workspace-id', 'user-id');

    expect(db.updateTable).toHaveBeenCalledWith('users');
    expect(updated.set).toHaveBeenCalledWith({ deactivatedAt: expect.any(Date) });
    expect(updated.where).toHaveBeenCalledWith('id', '=', 'user-id');
    expect(updated.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      'workspace-id',
    );
    expect(db.deleteFrom).not.toHaveBeenCalled();
  });

  it('rejects deletion of the Everyone group before issuing a delete', async () => {
    const db = { deleteFrom: jest.fn() };
    const service = new ScimResourceService(db as any, {} as any);
    jest.spyOn(service as any, 'defaultGroup').mockResolvedValue({
      id: 'everyone-id',
    });

    await expect(
      service.deleteGroup('workspace-id', 'everyone-id'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.deleteFrom).not.toHaveBeenCalled();
  });
});
