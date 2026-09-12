import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiKeyService } from './api-key.service';
import { UserRole } from '../../common/helpers/types/permission';

const user = {
  id: 'user',
  workspaceId: 'workspace',
  role: UserRole.ADMIN,
} as any;

describe('ApiKeyService', () => {
  it('rejects an expiry that is already elapsed', async () => {
    const service = new ApiKeyService({} as any, {} as any, {} as any);
    await expect(
      service.create(user, 'automation', ['read'], new Date(Date.now() - 1)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a bearer only at creation and stores only its hash', async () => {
    const repo = {
      create: jest.fn().mockResolvedValue({ id: 'key', secretHash: '' }),
      setSecretHash: jest.fn(),
    };
    const tokens = { generateApiToken: jest.fn().mockResolvedValue('secret') };
    const service = new ApiKeyService(repo as any, tokens as any, {} as any);
    const result = await service.create(user, 'automation', ['read']);
    expect(result.token).toBe('secret');
    expect(result.apiKey).not.toHaveProperty('secretHash');
    expect(repo.setSecretHash).toHaveBeenCalledWith(
      'key',
      expect.not.stringContaining('secret'),
    );
  });

  it('rejects a different bearer or expired key', async () => {
    const repo = {
      findActive: jest.fn().mockResolvedValue({
        id: 'key',
        creatorId: 'user',
        secretHash: 'wrong',
        expiresAt: null,
      }),
    };
    const service = new ApiKeyService(repo as any, {} as any, {} as any);
    await expect(
      service.validateApiKey(
        { apiKeyId: 'key', workspaceId: 'workspace', sub: 'user' } as any,
        'secret',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects expired and cross-workspace keys before marking use', async () => {
    const secretHash = createHash('sha256').update('secret').digest('hex');
    const repo = {
      findActive: jest.fn().mockResolvedValue({
        id: 'key',
        creatorId: 'user',
        secretHash,
        expiresAt: new Date(0),
      }),
      markUsed: jest.fn(),
    };
    const service = new ApiKeyService(repo as any, {} as any, {} as any);
    await expect(
      service.validateApiKey(
        { apiKeyId: 'key', workspaceId: 'other', sub: 'user' } as any,
        'secret',
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(repo.findActive).toHaveBeenCalledWith('key', 'other');
    expect(repo.markUsed).not.toHaveBeenCalled();
  });

  it('lets a member list only their own keys', async () => {
    const repo = { list: jest.fn().mockResolvedValue([]) };
    const service = new ApiKeyService(
      repo as any,
      {} as any,
      { findById: jest.fn().mockResolvedValue({ settings: {} }) } as any,
    );
    await expect(
      service.list({ ...user, role: UserRole.MEMBER }),
    ).resolves.toEqual([]);
    expect(repo.list).toHaveBeenCalledWith(user.workspaceId, user.id);
  });

  it('prevents a member from managing workspace keys', async () => {
    const service = new ApiKeyService({} as any, {} as any, {} as any);
    await expect(
      service.listWorkspace({ ...user, role: UserRole.MEMBER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks member personal keys when workspace policy restricts them', async () => {
    const workspaces = {
      findById: jest.fn().mockResolvedValue({
        settings: { api: { restrictApiKeysToAdmins: true } },
      }),
    };
    const service = new ApiKeyService({} as any, {} as any, workspaces as any);
    await expect(
      service.list({ ...user, role: UserRole.MEMBER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an administrator to list every workspace key', async () => {
    const repo = { listWorkspace: jest.fn().mockResolvedValue([]) };
    const service = new ApiKeyService(repo as any, {} as any, {} as any);
    await expect(service.listWorkspace(user)).resolves.toEqual([]);
    expect(repo.listWorkspace).toHaveBeenCalledWith(user.workspaceId);
  });

  it('renames and revokes only the caller personal key', async () => {
    const repo = { rename: jest.fn(), revoke: jest.fn() };
    const service = new ApiKeyService(repo as any, {} as any, {} as any);
    await service.rename(user, 'key', 'renamed');
    await service.revoke(user, 'key');
    expect(repo.rename).toHaveBeenCalledWith(
      'key',
      user.workspaceId,
      user.id,
      'renamed',
    );
    expect(repo.revoke).toHaveBeenCalledWith('key', user.workspaceId, user.id);
  });

  it('lets administrators rename and revoke workspace keys without creator ownership', async () => {
    const repo = { renameWorkspace: jest.fn(), revokeWorkspace: jest.fn() };
    const service = new ApiKeyService(repo as any, {} as any, {} as any);
    await service.renameWorkspace(user, 'key', 'renamed');
    await service.revokeWorkspace(user, 'key');
    expect(repo.renameWorkspace).toHaveBeenCalledWith(
      'key',
      user.workspaceId,
      'renamed',
    );
    expect(repo.revokeWorkspace).toHaveBeenCalledWith('key', user.workspaceId);
  });

  it('rejects API key scopes that have no guard mapping', async () => {
    const service = new ApiKeyService({} as any, {} as any, {} as any);
    await expect(
      service.create(user, 'automation', ['unknown']),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ApiKeyService audit trail', () => {
  it('awaits a redacted create audit after the key hash is stored', async () => {
    const repo = {
      create: jest.fn().mockResolvedValue({ id: 'key', name: 'automation', scopes: ['read'], expiresAt: null, secretHash: '' }),
      setSecretHash: jest.fn(),
    };
    const audit = { logWithContext: jest.fn() };
    const service = new ApiKeyService(
      repo as any,
      { generateApiToken: jest.fn().mockResolvedValue('secret') } as any,
      {} as any,
      audit as any,
    );
    await service.create(user, 'automation', ['read']);
    expect(audit.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'api_key.created', resourceId: 'key' }),
      expect.objectContaining({ workspaceId: user.workspaceId, actorId: user.id }),
    );
    expect(audit.logWithContext.mock.invocationCallOrder[0]).toBeGreaterThan(
      repo.setSecretHash.mock.invocationCallOrder[0],
    );
  });
});
