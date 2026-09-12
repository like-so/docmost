import { BaseRealtimeBridge } from './base-realtime.bridge';

describe('BaseRealtimeBridge', () => {
  it('accepts only versioned base change events', () => {
    const bridge = new BaseRealtimeBridge({} as any, {} as any, {} as any, {} as any);
    expect(bridge.isBaseEvent({ type: 'base:changed', pageId: 'page', version: 2 })).toBe(true);
    expect(bridge.isBaseEvent({ type: 'base:changed', pageId: 'page', version: 1.5 })).toBe(false);
    expect(bridge.isBaseEvent({ type: 'base:changed', version: 2 })).toBe(false);
  });

  it('broadcasts the current version only to sockets authorized for the base page', async () => {
    const allowed = { data: { userId: 'allowed' }, emit: jest.fn() };
    const denied = { data: { userId: 'denied' }, emit: jest.fn() };
    const bridge = new BaseRealtimeBridge(
      { findById: jest.fn().mockResolvedValue({ id: 'editor' }) } as any,
      { get: jest.fn().mockResolvedValue({ page: { id: 'page', spaceId: 'space', workspaceId: 'workspace', baseSchemaVersion: 3 }, permissions: { canEdit: true } }) } as any,
      { getUserIdsWithPageAccess: jest.fn().mockResolvedValue(['allowed']) } as any,
      { getUserIdsWithSpaceAccess: jest.fn().mockResolvedValue(new Set(['allowed'])) } as any,
    );
    bridge.setServer({ in: jest.fn().mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([allowed, denied]) }) } as any);
    await bridge.handleInbound({ data: { userId: 'editor', workspaceId: 'workspace' } } as any, { type: 'base:changed', pageId: 'page', version: 2 });
    expect(allowed.emit).toHaveBeenCalledWith('base:changed', { pageId: 'page', version: 3 });
    expect(denied.emit).not.toHaveBeenCalled();
  });

  it('requires both space membership and inherited page access for recipients', async () => {
    const member = { data: { userId: 'member' }, emit: jest.fn() };
    const nonMember = { data: { userId: 'non-member' }, emit: jest.fn() };
    const bridge = new BaseRealtimeBridge(
      { findById: jest.fn().mockResolvedValue({ id: 'editor' }) } as any,
      { get: jest.fn().mockResolvedValue({ page: { id: 'page', spaceId: 'space', workspaceId: 'workspace', baseSchemaVersion: 3 }, permissions: { canEdit: true } }) } as any,
      { getUserIdsWithPageAccess: jest.fn().mockResolvedValue(['member']) } as any,
      { getUserIdsWithSpaceAccess: jest.fn().mockResolvedValue(new Set(['member'])) } as any,
    );
    bridge.setServer({ in: jest.fn().mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([member, nonMember]) }) } as any);
    await bridge.handleInbound({ data: { userId: 'editor', workspaceId: 'workspace' } } as any, { type: 'base:changed', pageId: 'page', version: 2 });
    expect(member.emit).toHaveBeenCalledWith('base:changed', { pageId: 'page', version: 3 });
    expect(nonMember.emit).not.toHaveBeenCalled();
  });
});
