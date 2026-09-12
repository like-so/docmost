import { BadRequestException } from '@nestjs/common';
import { GroupSyncService } from './group-sync.service';
import { GroupSyncStore } from '../ports/group-sync.store';

describe('GroupSyncService', () => {
  let store: jest.Mocked<GroupSyncStore>;
  let service: GroupSyncService;
  const group = {
    externalId: 'eng',
    displayName: 'Engineering',
    memberExternalIds: ['alice', 'bob'],
  };

  beforeEach(() => {
    store = {
      syncGroup: jest.fn(),
      replaceGroup: jest.fn(),
      syncUserGroups: jest.fn(),
    };
    service = new GroupSyncService(store);
  });

  it('authoritatively synchronizes groups within one workspace', async () => {
    await service.sync('workspace-a', group);
    expect(store.syncGroup).toHaveBeenCalledWith('workspace-a', group);
  });

  it('deduplicates members to make repeated SCIM requests idempotent', async () => {
    await service.sync('workspace-a', {
      ...group,
      memberExternalIds: ['alice', 'alice'],
    });
    expect(store.syncGroup).toHaveBeenCalledWith('workspace-a', {
      ...group,
      memberExternalIds: ['alice'],
    });
  });

  it('rejects missing external IDs before persisting', async () => {
    await expect(
      service.sync('workspace-a', { ...group, externalId: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.syncGroup).not.toHaveBeenCalled();
  });
  it('replaces a group through the source-aware store', async () => {
    await service.replace('workspace-a', 'group-a', group);
    expect(store.replaceGroup).toHaveBeenCalledWith(
      'workspace-a',
      'group-a',
      group,
    );
  });
  it('synchronizes login memberships within the supplied workspace', async () => {
    await service.syncUserGroups('workspace-a', 'user-a', 'provider-a', [
      'eng',
      ' Engineering ',
      'eng',
    ]);
    expect(store.syncUserGroups).toHaveBeenCalledWith('workspace-a', 'user-a', 'provider-a', [
      'eng',
      'engineering',
    ]);
  });
  it('passes empty memberships as an authoritative removal', async () => {
    await service.syncUserGroups('workspace-a', 'user-a', 'provider-a', []);
    expect(store.syncUserGroups).toHaveBeenCalledWith(
      'workspace-a',
      'user-a',
      'provider-a',
      [],
    );
  });

  it('keeps login membership synchronization workspace scoped', async () => {
    await service.syncUserGroups('workspace-b', 'user-a', 'provider-b', ['eng']);
    expect(store.syncUserGroups).toHaveBeenCalledWith('workspace-b', 'user-a', 'provider-b', [
      'eng',
    ]);
  });
});

describe('GroupSyncService source boundaries', () => {
  it('does not expose automatic group creation to SSO callers', async () => {
    const store = {
      syncGroup: jest.fn(),
      replaceGroup: jest.fn(),
      syncUserGroups: jest.fn(),
    };
    const service = new GroupSyncService(store);
    await service.syncUserGroups('workspace-a', 'user-a', 'provider-a', [' Operations ']);
    expect(store.syncUserGroups).toHaveBeenCalledWith('workspace-a', 'user-a', 'provider-a', [
      'operations',
    ]);
    expect(store.syncGroup).not.toHaveBeenCalled();
  });
});
