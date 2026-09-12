import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ScimTokenService } from './scim-token.service';
import { ScimTokenStore } from '../ports/scim-token.store';

describe('ScimTokenService', () => {
  let store: jest.Mocked<ScimTokenStore>;
  let service: ScimTokenService;
  let db: any;

  beforeEach(() => {
    store = {
      create: jest.fn(),
      findActiveByHash: jest.fn(),
      markUsed: jest.fn(),
      revoke: jest.fn(),
      list: jest.fn(),
    };
    db = {
      selectFrom: jest.fn(() => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: jest
              .fn()
              .mockResolvedValue({ isScimEnabled: true }),
          }),
        }),
      })),
    };
    service = new ScimTokenService(store, db);
  });

  it('stores only a hash and returns the plaintext token once', async () => {
    store.create.mockResolvedValue({
      id: 'token-id',
      name: 'Directory',
      tokenLastFour: 'abcd',
      isEnabled: true,
      createdAt: new Date(),
    });
    const result = await service.create(
      'Directory',
      'workspace-id',
      'owner-id',
    );
    expect(result.token).toMatch(/^scim_/);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-id',
        creatorId: 'owner-id',
        tokenLastFour: result.token.slice(-4),
      }),
    );
    expect(store.create.mock.calls[0][0].tokenHash).not.toBe(result.token);
  });

  it('authenticates enabled tokens and records use without exposing the hash', async () => {
    store.findActiveByHash.mockResolvedValue({
      id: 'token-id',
      workspaceId: 'workspace-id',
      isEnabled: true,
    });
    await expect(service.authenticate('token')).resolves.toEqual(
      'workspace-id',
    );
    expect(store.markUsed).toHaveBeenCalledWith('token-id');
  });

  it('rejects missing, revoked, and malformed bearer tokens', async () => {
    await expect(service.authenticate('')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    store.findActiveByHash.mockResolvedValue(undefined);
    await expect(service.authenticate('unknown')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects token creation and existing tokens when SCIM is disabled', async () => {
    db.selectFrom.mockReturnValue({
      select: () => ({
        where: () => ({
          executeTakeFirst: jest
            .fn()
            .mockResolvedValue({ isScimEnabled: false }),
        }),
      }),
    });
    await expect(
      service.create('Directory', 'workspace-id', 'owner-id'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    store.findActiveByHash.mockResolvedValue({
      id: 'token-id',
      workspaceId: 'workspace-id',
      isEnabled: true,
    });
    await expect(service.authenticate('token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.markUsed).not.toHaveBeenCalled();
  });

  it('redacts token hashes from list output', async () => {
    store.list.mockResolvedValue([
      {
        id: 'token-id',
        name: 'Directory',
        tokenLastFour: 'abcd',
        isEnabled: true,
        createdAt: new Date(),
        tokenHash: 'secret',
      },
    ]);
    await expect(service.list('workspace-id')).resolves.toEqual([
      {
        id: 'token-id',
        name: 'Directory',
        lastFour: 'abcd',
        isEnabled: true,
        createdAt: expect.any(Date),
      },
    ]);
  });
});

describe('ScimTokenService audit trail', () => {
  it('records a redacted token creation after the token record is stored', async () => {
    const store = { create: jest.fn().mockResolvedValue({ id: 'token-id', name: 'Directory', tokenLastFour: 'abcd' }) };
    const db = { selectFrom: jest.fn(() => ({ select: () => ({ where: () => ({ executeTakeFirst: jest.fn().mockResolvedValue({ isScimEnabled: true }) }) }) })) };
    const audit = { logWithContext: jest.fn() };
    const service = new ScimTokenService(store as any, db as any, audit as any);
    await service.create('Directory', 'workspace-id', 'owner-id');
    expect(audit.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scim_token.created', changes: { after: { name: 'Directory', lastFour: 'abcd' } } }),
      expect.objectContaining({ workspaceId: 'workspace-id', actorId: 'owner-id' }),
    );
  });
});
