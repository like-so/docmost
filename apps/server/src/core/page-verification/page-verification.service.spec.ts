import { PageVerificationService } from './page-verification.service';

describe('PageVerificationService', () => {
  it('lists workspace verifications for an owner', async () => {
    const execute = jest.fn().mockResolvedValue([{ id: 'verification' }]);
    const orderBy = jest.fn().mockReturnValue({ execute });
    const groupBy = jest.fn().mockReturnValue({ orderBy });
    const where = jest.fn().mockReturnValue({ groupBy });
    const select = jest.fn().mockReturnValue({ where });
    const leftJoin = jest.fn().mockReturnValue({ select });
    const db = { selectFrom: jest.fn().mockReturnValue({ leftJoin }) };
    const service = new PageVerificationService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
      { logWithContext: jest.fn(), logWithContextInTransaction: jest.fn() } as any,
    );

    await expect(
      service.list({ id: 'owner', role: 'owner' } as any, 'workspace'),
    ).resolves.toEqual([{ id: 'verification', canVerify: true }]);

    expect(where).toHaveBeenCalledWith(
      'pageVerifications.workspaceId',
      '=',
      'workspace',
    );
    expect(orderBy).toHaveBeenCalledWith(
      'pageVerifications.requestedAt',
      'desc',
    );
  });

  it('records a read acknowledgement as an idempotent page/user confirmation', async () => {
    const returningAll = jest.fn().mockReturnValue({
      executeTakeFirst: jest.fn().mockResolvedValue({ id: 'read' }),
    });
    const db = {
      insertInto: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflict: jest.fn().mockReturnValue({ returningAll }),
        }),
      }),
    };
    const pages = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'page', workspaceId: 'workspace' }),
    };
    const access = { validateCanView: jest.fn() };
    const service = new PageVerificationService(
      db as any,
      pages as any,
      access as any,
      {} as any,
      { logWithContext: jest.fn(), logWithContextInTransaction: jest.fn() } as any,
    );
    await expect(
      service.acknowledge({ id: 'user' } as any, 'workspace', 'page'),
    ).resolves.toEqual({ id: 'read' });
    expect(access.validateCanView).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'page' }),
      expect.objectContaining({ id: 'user' }),
    );
    expect(db.insertInto).toHaveBeenCalledWith('pageReadConfirmations');
  });
});

describe('PageVerificationService state changes', () => {
  const user = { id: 'verifier', role: 'member' } as any;
  const verification = {
    id: 'verification',
    pageId: 'page',
    spaceId: 'space',
    workspaceId: 'workspace',
  };

  function authorizedDb(results: Array<any>) {
    const pageVerification = {
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue(verification),
    };
    const pageVerifiers = {
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue({ id: 'assignment' }),
      execute: jest.fn().mockResolvedValue([{ userId: user.id }]),
    };
    const update = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returningAll: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn(() => Promise.resolve(results.shift())),
    };
    return {
      selectFrom: jest.fn((table) =>
        table === 'pageVerifications'
          ? { selectAll: jest.fn().mockReturnValue(pageVerification) }
          : { select: jest.fn().mockReturnValue(pageVerifiers) },
      ),
      updateTable: jest.fn().mockReturnValue(update),
      update,
    };
  }

  it('allows exactly one concurrent terminal winner and does not notify a loser', async () => {
    const db = authorizedDb([
      { ...verification, status: 'verified' },
      undefined,
    ]);
    const notifications = { add: jest.fn() };
    const service = new PageVerificationService(
      db as any,
      { findById: jest.fn().mockResolvedValue({ id: 'page' }) } as any,
      { validateCanView: jest.fn() } as any,
      notifications as any,
      { logWithContext: jest.fn(), logWithContextInTransaction: jest.fn() } as any,
    );

    await expect(
      service.verify(user, 'workspace', 'verification'),
    ).resolves.toMatchObject({ status: 'verified' });
    await expect(
      service.reject(user, 'workspace', 'verification'),
    ).rejects.toThrow('no longer pending');
    expect(db.update.where).toHaveBeenCalledWith('status', '=', 'requested');
    expect(notifications.add).toHaveBeenCalledTimes(1);
  });

  it('does not emit a terminal notification after a conditional transition loses', async () => {
    const db = authorizedDb([undefined]);
    const notifications = { add: jest.fn() };
    const service = new PageVerificationService(
      db as any,
      { findById: jest.fn().mockResolvedValue({ id: 'page' }) } as any,
      { validateCanView: jest.fn() } as any,
      notifications as any,
      { logWithContext: jest.fn(), logWithContextInTransaction: jest.fn() } as any,
    );

    await expect(
      service.verify(user, 'workspace', 'verification'),
    ).rejects.toThrow('no longer pending');
    expect(notifications.add).not.toHaveBeenCalled();
  });
});

describe('PageVerificationService request transaction', () => {
  it('rolls back verifier replacement and emits no notification when replacement fails', async () => {
    const transaction = { execute: jest.fn() };
    const trx = {
      selectFrom: jest.fn((table: string) => {
        if (table === 'users') {
          const users = {
            where: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue([{ id: 'verifier' }]),
          };
          return { select: jest.fn().mockReturnValue(users) };
        }
        return {
          select: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              executeTakeFirst: jest.fn().mockResolvedValue(undefined),
            }),
          }),
        };
      }),
      deleteFrom: jest.fn().mockReturnValue({
        where: jest
          .fn()
          .mockReturnValue({ execute: jest.fn().mockResolvedValue(undefined) }),
      }),
      insertInto: jest.fn((table: string) => {
        if (table === 'pageVerifications') {
          return {
            values: jest.fn().mockReturnValue({
              returningAll: jest.fn().mockReturnValue({
                executeTakeFirstOrThrow: jest
                  .fn()
                  .mockResolvedValue({ id: 'verification' }),
              }),
            }),
          };
        }
        return {
          values: jest.fn().mockReturnValue({
            execute: jest
              .fn()
              .mockRejectedValue(new Error('verifier insert failed')),
          }),
        };
      }),
    };
    transaction.execute.mockImplementation((callback: any) => callback(trx));
    const db = { ...trx, transaction: jest.fn().mockReturnValue(transaction) };
    const pages = {
      findById: jest
        .fn()
        .mockResolvedValue({
          id: 'page',
          workspaceId: 'workspace',
          spaceId: 'space',
        }),
    };
    const notifications = { add: jest.fn() };
    const service = new PageVerificationService(
      db as any,
      pages as any,
      { validateCanEdit: jest.fn(), validateCanView: jest.fn() } as any,
      notifications as any,
      { logWithContext: jest.fn(), logWithContextInTransaction: jest.fn() } as any,
    );

    await expect(
      service.request({ id: 'requester' } as any, 'workspace', {
        pageId: 'page',
        verifierIds: ['verifier'],
      }),
    ).rejects.toThrow('verifier insert failed');
    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(trx.deleteFrom).toHaveBeenCalledWith('pageVerifiers');
    expect(notifications.add).not.toHaveBeenCalled();
  });
});
