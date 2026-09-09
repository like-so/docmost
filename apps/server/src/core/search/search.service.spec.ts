import { SearchService } from './search.service';

describe('SearchService', () => {
  it('filters restricted pages from authenticated search results', async () => {
    const query: any = {
      select: jest.fn(),
      selectFrom: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      offset: jest.fn(),
      execute: jest.fn().mockResolvedValue([
        { id: 'restricted', title: 'Hidden' },
        { id: 'allowed', title: 'Visible' },
      ]),
    };
    for (const method of Object.keys(query)) {
      if (method !== 'execute') query[method].mockReturnValue(query);
    }
    query.$if = jest.fn((condition, callback) =>
      condition ? callback(query) : query,
    );

    const permissions = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['allowed']),
    };
    const service = new SearchService(
      { selectFrom: jest.fn().mockReturnValue(query) } as any,
      { withSpace: jest.fn() } as any,
      {} as any,
      { getUserSpaceIdsQuery: jest.fn().mockReturnValue(query) } as any,
      permissions as any,
    );

    const result = await service.searchPage(
      { query: 'page', limit: 10 } as any,
      { userId: 'user', workspaceId: 'workspace' },
    );

    expect(permissions.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['restricted', 'allowed'],
      userId: 'user',
      spaceId: undefined,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('allowed');
  });
});
