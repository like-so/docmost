import { GroupUserService } from './group-user.service';

describe('GroupUserService membership provenance', () => {
  it('records manual ownership when adding a user who already has an SSO membership', async () => {
    const values = jest.fn(() => ({
      onConflict: jest.fn(() => ({ execute: jest.fn() })),
    }));
    const db: any = {
      selectFrom: jest.fn(() => ({
        select: jest.fn(() => ({
          where: jest.fn(() => ({
            where: jest.fn(() => ({ execute: jest.fn().mockResolvedValue([{ id: 'user' }]) })),
          })),
        })),
      })),
      insertInto: jest.fn(() => ({ values })),
    };
    db.transaction = jest.fn(() => ({
      execute: jest.fn((callback) => callback(db)),
    }));
    const service = new GroupUserService(
      {} as any,
      {} as any,
      {} as any,
      { findAndValidateGroup: jest.fn() } as any,
      {} as any,
      {} as any,
      db as any,
      { logInTransaction: jest.fn() } as any,
    );

    await service.addUsersToGroupBatch(['user'], 'group', 'workspace');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.insertInto).toHaveBeenNthCalledWith(1, 'groupUsers');
    expect(db.insertInto).toHaveBeenNthCalledWith(
      2,
      'groupMembershipSources',
    );
    expect(values).toHaveBeenLastCalledWith([
      expect.objectContaining({
        groupId: 'group',
        userId: 'user',
        source: 'manual',
        providerId: '',
      }),
    ]);
  });
});
