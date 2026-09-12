import { AuditRepo } from './audit.repo';

describe('AuditRepo outbox atomicity', () => {
  const data = { workspaceId: 'workspace' } as any;

  it('uses one internal transaction for audit and outbox writes', async () => {
    const auditInsert = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      executeTakeFirstOrThrow: jest.fn().mockResolvedValue({ id: 'audit' }),
    };
    const transaction = { insertInto: jest.fn().mockReturnValue(auditInsert) };
    const database = {
      transaction: () => ({
        execute: (callback: any) => callback(transaction),
      }),
    };
    const outbox = { createForAudit: jest.fn().mockResolvedValue(undefined) };
    const repo = new AuditRepo(database as any, outbox as any);

    await repo.append(data);

    expect(auditInsert.executeTakeFirstOrThrow).toHaveBeenCalled();
    expect(outbox.createForAudit).toHaveBeenCalledWith('audit', 'workspace', transaction);
  });

  it('propagates an outbox failure through the transaction callback', async () => {
    const auditInsert = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      executeTakeFirstOrThrow: jest.fn().mockResolvedValue({ id: 'audit' }),
    };
    const transaction = { insertInto: jest.fn().mockReturnValue(auditInsert) };
    const execute = jest.fn((callback: any) => callback(transaction));
    const repo = new AuditRepo(
      { transaction: () => ({ execute }) } as any,
      { createForAudit: jest.fn().mockRejectedValue(new Error('outbox failed')) } as any,
    );

    await expect(repo.append(data)).rejects.toThrow('outbox failed');

    expect(execute).toHaveBeenCalled();
  });
});
