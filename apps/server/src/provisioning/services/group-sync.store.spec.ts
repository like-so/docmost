jest.mock('@docmost/db/utils', () => ({
  executeTx: jest.fn(async (db, callback) => callback(db)),
}));

import { KyselyGroupSyncStore } from './group-sync.store';

function query(rows: unknown[]) {
  const builder: any = {
    select: jest.fn(() => builder),
    where: jest.fn(() => builder),
    innerJoin: jest.fn(() => builder),
    execute: jest.fn().mockResolvedValue(rows),
  };
  return builder;
}

describe('KyselyGroupSyncStore membership provenance', () => {
  it('looks up only pre-created case-insensitive group names', async () => {
    const groups = query([{ id: 'group-eng', isDefault: false }]);
    const db = { selectFrom: jest.fn(() => groups) };
    const store = new KyselyGroupSyncStore(db as any);

    await expect(
      (store as any).findNamedGroups(
        db,
        'workspace-id',
        [' Engineering ', 'engineering', ''],
      ),
    ).resolves.toEqual([{ id: 'group-eng', isDefault: false }]);

    expect(groups.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      'workspace-id',
    );
    expect(groups.where).toHaveBeenCalledWith('isExternal', '=', false);
    expect(groups.where).toHaveBeenLastCalledWith(
      expect.anything(),
      'in',
      ['engineering'],
    );
    expect(db.selectFrom).toHaveBeenCalledWith('groups');
  });

  it('does not require a workspace SCIM flag to preserve SCIM-owned membership', async () => {
    const named = query([{ id: 'group-eng', isDefault: false }]);
    const scim = query([{ groupId: 'group-eng' }]);
    const sso = query([]);
    const db = {
      selectFrom: jest.fn((table: string) => {
        if (table === 'groups') return named;
        if (table === 'groupMembershipSources')
          return scim.execute.mock.calls.length ? sso : scim;
        throw new Error(`unexpected table ${table}`);
      }),
    };
    const store = new KyselyGroupSyncStore(db as any);

    await store.syncUserGroups('workspace-id', 'user-id', 'provider-id', ['Engineering']);

    expect(db.selectFrom).not.toHaveBeenCalledWith('workspaces');
    expect(scim.where).toHaveBeenCalledWith('source', '=', 'scim');
    expect(sso.execute).toHaveBeenCalled();
    expect(db.selectFrom).not.toHaveBeenCalledWith('groupUsers');
  });

  it('never reads external groups as SSO membership sources', async () => {
    const sourceRows = {
      select: jest.fn(function () {
        return this;
      }),
      where: jest.fn(function () {
        return this;
      }),
      innerJoin: jest.fn(function () {
        return this;
      }),
      execute: jest.fn().mockResolvedValue([]),
    };
    const db = {
      selectFrom: jest.fn(() => sourceRows),
    };
    const store = new KyselyGroupSyncStore(db as any);

    await expect(
      (store as any).sourceRows(db, 'user-id', 'sso', 'provider-id'),
    ).resolves.toEqual([]);

    expect(sourceRows.innerJoin).toHaveBeenCalledWith(
      'groups',
      'groups.id',
      'groupMembershipSources.groupId',
    );
    expect(sourceRows.where).toHaveBeenCalledWith(
      'groups.isExternal',
      '=',
      false,
    );
  });

  it('does not add or remove SSO membership when only external groups match', async () => {
    const store = new KyselyGroupSyncStore({} as any);
    const add = jest
      .spyOn(store as any, 'addSource')
      .mockResolvedValue(undefined);
    const remove = jest
      .spyOn(store as any, 'removeSource')
      .mockResolvedValue(undefined);
    jest.spyOn(store as any, 'findNamedGroups').mockResolvedValue([]);
    jest.spyOn(store as any, 'scimGroups').mockResolvedValue(new Set());
    jest.spyOn(store as any, 'sourceRows').mockResolvedValue([]);

    await store.syncUserGroups('workspace-id', 'user-id', 'provider-id', ['SCIM Engineering']);

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('adds desired source edges and removes only stale edges from that source', async () => {
    const store = new KyselyGroupSyncStore({} as any);
    const old = {
      groupId: 'group-id',
      userId: 'old-user',
      createdMembership: true,
    };
    const add = jest
      .spyOn(store as any, 'addSource')
      .mockResolvedValue(undefined);
    const remove = jest
      .spyOn(store as any, 'removeSource')
      .mockResolvedValue(undefined);
    jest.spyOn(store as any, 'sourceRows').mockResolvedValue([old]);

    await (store as any).replaceSource(
      {},
      undefined,
      'scim',
      '',
      [{ groupId: 'group-id', userId: 'new-user' }],
      'group-id',
    );

    expect(remove).toHaveBeenCalledWith({}, old, 'scim', '');
    expect(add).toHaveBeenCalledWith(
      {},
      { groupId: 'group-id', userId: 'new-user' },
      'scim',
      '',
    );
  });

  it('does not delete a manual membership when its SSO provenance is removed', async () => {
    const execute = jest.fn();
    const query = {
      where: jest.fn(function () {
        return this;
      }),
      select: jest.fn(function () {
        return this;
      }),
      executeTakeFirst: jest.fn().mockResolvedValue(undefined),
      execute,
    };
    const db = {
      deleteFrom: jest.fn(() => query),
      selectFrom: jest.fn(() => query),
    };
    const store = new KyselyGroupSyncStore(db as any);

    await (store as any).removeSource(
      db,
      { groupId: 'group-id', userId: 'user-id', createdMembership: false },
      'sso',
      'provider-id',
    );

    expect(db.deleteFrom).toHaveBeenCalledWith('groupMembershipSources');
    expect(db.deleteFrom).not.toHaveBeenCalledWith('groupUsers');
  });

  it('keeps a manual membership when an SSO provider removes its source', async () => {
    const provenance = {
      select: jest.fn(function () {
        return this;
      }),
      where: jest.fn(function () {
        return this;
      }),
      executeTakeFirst: jest.fn().mockResolvedValue({ id: 'manual-source' }),
    };
    const removal = {
      where: jest.fn(function () {
        return this;
      }),
      execute: jest.fn(),
    };
    const db = {
      deleteFrom: jest.fn(() => removal),
      selectFrom: jest.fn(() => provenance),
    };
    const store = new KyselyGroupSyncStore(db as any);

    await (store as any).removeSource(
      db,
      { groupId: 'group-id', userId: 'user-id', createdMembership: true },
      'sso',
      'provider-id',
    );

    expect(db.deleteFrom).toHaveBeenCalledWith('groupMembershipSources');
    expect(db.deleteFrom).not.toHaveBeenCalledWith('groupUsers');
  });
  it('removes only the memberships owned by the provider being synchronized', async () => {
    const store = new KyselyGroupSyncStore({} as any);
    const remove = jest
      .spyOn(store as any, 'removeSource')
      .mockResolvedValue(undefined);
    jest.spyOn(store as any, 'addSource').mockResolvedValue(undefined);
    jest.spyOn(store as any, 'sourceRows').mockResolvedValue([
      { groupId: 'group-id', userId: 'user-id', createdMembership: true },
    ]);

    await (store as any).replaceSource(
      {},
      'user-id',
      'sso',
      'provider-a',
      [],
    );

    expect((store as any).sourceRows).toHaveBeenCalledWith(
      {},
      'user-id',
      'sso',
      'provider-a',
      undefined,
    );
    expect(remove).toHaveBeenCalledWith(
      {},
      { groupId: 'group-id', userId: 'user-id', createdMembership: true },
      'sso',
      'provider-a',
    );
  });

});
