import { SiemService } from './siem.service';

describe('SiemService', () => {
  const destination = {
    id: 'destination-1',
    workspaceId: 'workspace-1',
    name: 'Collector',
    type: 'webhook',
    enabled: true,
    config: { url: 'https://collector.example/events' },
    secrets: 'encrypted-secret',
  };

  it('encrypts secrets before persistence and redacts them on read', async () => {
    const repo = { create: jest.fn().mockResolvedValue(destination) };
    const service = new SiemService(
      repo as any,
      {
        encrypt: jest.fn().mockReturnValue('encrypted-secret'),
      } as any,
      { logWithContext: jest.fn() } as any,
    );

    const result = await service.create('workspace-1', 'user-1', {
      name: 'Collector',
      type: 'webhook',
      config: { url: 'https://collector.example/events' },
      secrets: { token: 'plain-text' },
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: 'encrypted-secret' }),
    );
    expect(result).not.toHaveProperty('secrets');
    expect((service as any).auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'siem_destination.created' }),
      expect.objectContaining({ workspaceId: 'workspace-1', actorId: 'user-1' }),
    );
  });

  it('disables a destination after the configured failure threshold', async () => {
    const repo = {
      recordFailure: jest.fn().mockResolvedValue({ consecutiveFailures: 3 }),
      disable: jest.fn(),
    };
    const service = new SiemService(repo as any, {} as any, {} as any);

    await service.recordFailure('destination-1', 'request failed');

    expect(repo.disable).toHaveBeenCalledWith('destination-1');
  });
});
