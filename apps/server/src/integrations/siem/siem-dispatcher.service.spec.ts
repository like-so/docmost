import { SiemDispatcherService } from './siem-dispatcher.service';

describe('SiemDispatcherService outbox', () => {
  it('queues a committed outbox row even when its audit emitted no event', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const destination = { id: 'destination', workspaceId: 'workspace', enabled: true };
    const outbox = {
      next: jest.fn().mockResolvedValue({ id: 'outbox-a', auditId: 'audit-a' }),
    };
    const service = new SiemDispatcherService(
      {
        listEnabled: jest.fn().mockResolvedValue([destination]),
        list: jest.fn(),
        findById: jest.fn(),
      } as any,
      outbox as any,
      queue as any,
      { doesExist: jest.fn() } as any,
      { getSiemReconcileIntervalMs: jest.fn() } as any,
    );

    await service.reconcile();

    expect(outbox.next).toHaveBeenCalledWith('destination');
    expect(queue.add).toHaveBeenCalledWith(
      'siem-deliver',
      { destinationId: 'destination', auditId: 'audit-a' },
      { jobId: 'destination-audit-a' },
    );
  });

  it('keeps a late-committing A separate from B instead of cursor-skipping A', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const destination = { id: 'destination', workspaceId: 'workspace', enabled: true };
    const outbox = {
      next: jest
        .fn()
        .mockResolvedValueOnce({ id: 'outbox-b', auditId: 'audit-b' })
        .mockResolvedValueOnce({ id: 'outbox-a', auditId: 'audit-a' }),
    };
    const service = new SiemDispatcherService(
      {
        list: jest.fn().mockResolvedValue([destination]),
        listEnabled: jest.fn().mockResolvedValue([destination]),
        findById: jest.fn().mockResolvedValue(destination),
      } as any,
      outbox as any,
      queue as any,
      { doesExist: jest.fn() } as any,
      { getSiemReconcileIntervalMs: jest.fn() } as any,
    );

    await service.dispatch({ id: 'audit-b', workspaceId: 'workspace' });
    await service.reconcile();

    expect(queue.add.mock.calls).toEqual([
      ['siem-deliver', { destinationId: 'destination', auditId: 'audit-b' }, { jobId: 'destination-audit-b' }],
      ['siem-deliver', { destinationId: 'destination', auditId: 'audit-a' }, { jobId: 'destination-audit-a' }],
    ]);
  });
});
