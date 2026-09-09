import { PageVerificationScheduler } from './page-verification.scheduler';

describe('PageVerificationScheduler', () => {
  function scheduler(db: any, notifications: any) {
    return new PageVerificationScheduler(
      db,
      notifications,
      {
        doesExist: jest.fn().mockReturnValue(false),
        addInterval: jest.fn(),
        deleteInterval: jest.fn(),
      } as any,
      {
        getVerificationReconcileIntervalMs: jest.fn().mockReturnValue(60_000),
      } as any,
    );
  }

  it('enqueues a single removable reconciliation job', async () => {
    const notifications = { add: jest.fn() };
    await scheduler({} as any, notifications).enqueueReconciliation();
    expect(notifications.add).toHaveBeenCalledWith(
      'verification-reconcile',
      {},
      expect.objectContaining({
        jobId: 'page-verification-reconcile',
        removeOnComplete: true,
      }),
    );
  });

  it('marks expired verifications and queues one expiry notification', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        id: 'verification',
        expiresAt: new Date(Date.now() - 1),
        status: 'verified',
      },
    ]);
    const db = {
      selectFrom: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ execute }),
          }),
        }),
      }),
      updateTable: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ execute: jest.fn() }),
        }),
      }),
    };
    const notifications = { add: jest.fn() };
    await scheduler(db, notifications).reconcile();
    expect(db.updateTable).toHaveBeenCalledWith('pageVerifications');
    expect(notifications.add).toHaveBeenCalledWith(
      'page-verification-expired',
      { verificationId: 'verification' },
    );
  });
});
