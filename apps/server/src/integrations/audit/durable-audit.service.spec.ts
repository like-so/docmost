import { DurableAuditService } from './durable-audit.service';

describe('DurableAuditService', () => {
  const context = {
    workspaceId: 'workspace-1',
    actorId: 'user-1',
    actorType: 'user' as const,
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  it('persists the full actor context supplied with an audit event', async () => {
    const auditRepo = {
      append: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };
    const service = new DurableAuditService(
      auditRepo as any,
      {
        get: jest.fn().mockReturnValue(context),
      } as any,
      { emit: jest.fn() } as any,
    );

    await service.log({ event: 'user.login', resourceType: 'user' });

    expect(auditRepo.append).toHaveBeenCalledWith({
      ...context,
      event: 'user.login',
      resourceType: 'user',
    });
  });

  it('uses an explicit context and ignores events without a workspace', async () => {
    const auditRepo = {
      append: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };
    const service = new DurableAuditService(
      auditRepo as any,
      {
        get: jest.fn().mockReturnValue(undefined),
      } as any,
      { emit: jest.fn() } as any,
    );

    await service.logWithContext(
      { event: 'user.login', resourceType: 'user' },
      context,
    );
    await service.log({ event: 'user.login', resourceType: 'user' });

    expect(auditRepo.append).toHaveBeenCalledTimes(1);
    expect(auditRepo.append).toHaveBeenCalledWith({
      ...context,
      event: 'user.login',
      resourceType: 'user',
    });
  });

  it('rejects logging when durable persistence fails', async () => {
    const auditRepo = { append: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new DurableAuditService(
      auditRepo as any,
      { get: jest.fn().mockReturnValue(context) } as any,
      { emit: jest.fn() } as any,
    );

    await expect(
      service.log({ event: 'user.login', resourceType: 'user' }),
    ).rejects.toThrow('down');
  });

  it('writes transaction-bound audits without emitting before commit', async () => {
    const auditRepo = {
      append: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };
    const events = { emit: jest.fn() };
    const service = new DurableAuditService(
      auditRepo as any,
      { get: jest.fn().mockReturnValue(context) } as any,
      events as any,
    );
    const trx = {} as any;

    await service.logInTransaction(
      { event: 'user.login', resourceType: 'user' },
      trx,
    );

    expect(auditRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: context.workspaceId }),
      trx,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not emit an audit event when the owning transaction rolls back', async () => {
    const auditRepo = { append: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const events = { emit: jest.fn() };
    const service = new DurableAuditService(
      auditRepo as any,
      { get: jest.fn().mockReturnValue(context) } as any,
      events as any,
    );

    await expect(
      Promise.resolve().then(async () => {
        await service.logInTransaction(
          { event: 'user.login', resourceType: 'user' },
          {} as any,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(events.emit).not.toHaveBeenCalled();
  });
});
