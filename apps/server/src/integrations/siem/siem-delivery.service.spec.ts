import { SiemDeliveryService } from './siem-delivery.service';
import * as undici from 'undici';

describe('SiemDeliveryService', () => {
  it('posts an audit event with an idempotency key and advances its durable cursor', async () => {
    const destination = {
      id: 'destination-1',
      workspaceId: 'workspace-1',
      enabled: true,
      version: 2,
      config: { url: 'https://collector.example/events' },
      secrets: 'encrypted',
    };
    const repo = {
      findById: jest.fn().mockResolvedValue(destination),
      markDelivered: jest.fn(),
      recordFailure: jest.fn(),
      disable: jest.fn(),
    };
    const auditRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'audit-1',
        workspaceId: 'workspace-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        event: 'user.login',
        resourceType: 'user',
        resourceId: 'user-1',
        metadata: { source: 'test' },
      }),
    };
    const lease = { dispatcher: {}, release: jest.fn() };
    const service = new SiemDeliveryService(
      repo as any,
      auditRepo as any,
      { next: jest.fn().mockResolvedValue({ id: 'outbox-1', auditId: 'audit-1' }), markDelivered: jest.fn() } as any,
      { decrypt: jest.fn().mockReturnValue('{"token":"secret"}') } as any,
      { lease: jest.fn().mockResolvedValue(lease) } as any,
      { getSiemRequestTimeoutMs: jest.fn().mockReturnValue(5_000) } as any,
    );
    const fetch = jest
      .spyOn(undici, 'fetch')
      .mockResolvedValue(new undici.Response(null, { status: 200 }));

    await service.deliver('destination-1', 'audit-1');

    expect(fetch).toHaveBeenCalledWith(
      'https://collector.example/events',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'audit-1' }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(repo.markDelivered).toHaveBeenCalledWith(
      'destination-1',
      new Date('2026-01-01T00:00:00Z'),
      'audit-1',
    );
    expect(lease.release).toHaveBeenCalled();
    expect(JSON.parse((fetch.mock.calls[0][1] as any).body)).toMatchObject({
      event: 'user.login',
      resourceType: 'user',
      resourceId: 'user-1',
      metadata: { source: 'test' },
    });
  });

  it('does not deliver a queued later audit before the persisted next audit', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({
        id: 'destination-1',
        workspaceId: 'workspace-1',
        enabled: true,
        config: { url: 'https://collector.example/events' },
        secrets: 'encrypted',
        cursorCreatedAt: new Date('2026-01-01T00:00:00Z'),
        cursorId: 'before-a',
      }),
      markDelivered: jest.fn(),
    };
    const auditRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'audit-a',
        workspaceId: 'workspace-1',
        createdAt: new Date('2026-01-01T00:00:01Z'),
      }),
    };
    const outbound = { lease: jest.fn() };
    const service = new SiemDeliveryService(
      repo as any,
      auditRepo as any,
      { next: jest.fn().mockResolvedValue({ id: 'outbox-1', auditId: 'audit-a' }), markDelivered: jest.fn() } as any,
      { decrypt: jest.fn() } as any,
      outbound as any,
      { getSiemRequestTimeoutMs: jest.fn() } as any,
    );

    await expect(service.deliver('destination-1', 'audit-b')).resolves.toBe(
      false,
    );

    expect(outbound.lease).not.toHaveBeenCalled();
    expect(repo.markDelivered).not.toHaveBeenCalled();
  });
});

it('forbids redirect following so every recipient is the leased destination', async () => {
  const repo = {
    findById: jest.fn().mockResolvedValue({
      id: 'destination-1',
      workspaceId: 'workspace-1',
      enabled: true,
      config: { url: 'https://collector.example/events' },
      secrets: 'encrypted',
    }),
    markDelivered: jest.fn(),
  };
  const lease = { dispatcher: {}, release: jest.fn() };
  const service = new SiemDeliveryService(
    repo as any,
    {
      findById: jest.fn().mockResolvedValue({
        id: 'audit-1',
        createdAt: new Date(),
        workspaceId: 'workspace-1',
      }),
    } as any,
    { next: jest.fn().mockResolvedValue({ id: 'outbox-1', auditId: 'audit-1' }), markDelivered: jest.fn() } as any,
    { decrypt: jest.fn().mockReturnValue('{}') } as any,
    { lease: jest.fn().mockResolvedValue(lease) } as any,
    { getSiemRequestTimeoutMs: jest.fn().mockReturnValue(5_000) } as any,
  );
  const fetch = jest
    .spyOn(undici, 'fetch')
    .mockResolvedValue(new undici.Response(null, { status: 302 }));

  await expect(service.deliver('destination-1', 'audit-1')).rejects.toThrow(
    'SIEM receiver returned 302',
  );
  expect(fetch).toHaveBeenCalledWith(
    'https://collector.example/events',
    expect.objectContaining({ redirect: 'error' }),
  );
  expect(repo.markDelivered).not.toHaveBeenCalled();
  expect(lease.release).toHaveBeenCalled();
});
