import { QueueJob } from '../queue/constants';
import { SiemProcessor } from './siem.processor';

describe('SiemProcessor ordering', () => {
  it('schedules the next audit only after the current audit succeeds', async () => {
    const delivery = { deliver: jest.fn().mockResolvedValue(true) };
    const dispatcher = { enqueueNextById: jest.fn() };
    const processor = new SiemProcessor(
      delivery as any,
      {} as any,
      dispatcher as any,
    );

    await processor.process({
      name: QueueJob.SIEM_DELIVER,
      data: { destinationId: 'destination', auditId: 'audit-a' },
    } as any);

    expect(dispatcher.enqueueNextById).toHaveBeenCalledWith('destination');
  });

  it('does not advance the chain when a stale job is rejected', async () => {
    const dispatcher = { enqueueNextById: jest.fn() };
    const processor = new SiemProcessor(
      { deliver: jest.fn().mockResolvedValue(false) } as any,
      {} as any,
      dispatcher as any,
    );

    await processor.process({
      name: QueueJob.SIEM_DELIVER,
      data: { destinationId: 'destination', auditId: 'audit-b' },
    } as any);

    expect(dispatcher.enqueueNextById).not.toHaveBeenCalled();
  });
});
