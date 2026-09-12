import { SiemDestinationRepo } from './siem-destination.repo';

describe('SiemDestinationRepo.markDelivered', () => {
  it('updates the cursor only with one atomic lexicographic tuple predicate', async () => {
    const execute = jest.fn();
    const whereCalls: any[] = [];
    const query = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn((...args: any[]) => {
        whereCalls.push(args);
        return query;
      }),
      execute,
    };
    const repo = new SiemDestinationRepo({
      updateTable: jest.fn().mockReturnValue(query),
    } as any);
    const timestamp = new Date('2026-01-01T00:00:00Z');

    await repo.markDelivered('destination', timestamp, 'event-b');

    expect(execute).toHaveBeenCalled();
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0]).toEqual(['id', '=', 'destination']);
    expect(typeof whereCalls[1][0]).toBe('function');
    const predicate: any = jest.fn((...parts) => parts);
    predicate.or = jest.fn((items) => items);
    predicate.and = jest.fn((items) => items);
    const condition = whereCalls[1][0](predicate);
    expect(predicate.or).toHaveBeenCalledTimes(1);
    expect(predicate.and).toHaveBeenCalledWith([
      ['cursorCreatedAt', '=', timestamp],
      ['cursorId', '<', 'event-b'],
    ]);
    expect(condition).toEqual(expect.any(Array));
  });
});
