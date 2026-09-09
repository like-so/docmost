import { SearchService } from './search.service';

describe('SearchService attachment search', () => {
  function chain(rows: any[]) {
    const query: any = { execute: jest.fn().mockResolvedValue(rows) };
    for (const method of [
      'innerJoin',
      'where',
      'orderBy',
      'limit',
      'offset',
    ]) {
      query[method] = jest.fn().mockReturnValue(query);
    }
    query.nestedQueries = [];
    query.select = jest.fn((selection) => {
      if (typeof selection === 'function') {
        const nested = {
          select: jest.fn(),
          whereRef: jest.fn(),
        };
        nested.select.mockReturnValue(nested);
        nested.whereRef.mockReturnValue(nested);
        query.nestedQueries.push(nested);
        selection({ selectFrom: jest.fn().mockReturnValue(nested) });
      }
      return query;
    });
    query.$if = jest.fn((condition, callback) =>
      condition ? callback(query) : query,
    );
    return query;
  }

  it('filters attachment results to current workspace, member spaces, and accessible pages', async () => {
    const query = chain([
      { id: 'hidden', pageId: 'p1' },
      { id: 'allowed', pageId: 'p2' },
    ]);
    const permissions = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['p2']),
    };
    const spaces = { getUserSpaceIdsQuery: jest.fn().mockReturnValue(query) };
    const service = new SearchService(
      { selectFrom: jest.fn().mockReturnValue(query) } as any,
      { withSpace: jest.fn() } as any,
      {} as any,
      spaces as any,
      permissions as any,
    );

    const result = await service.searchAttachments(
      { query: 'contract', limit: 10 } as any,
      { userId: 'u1', workspaceId: 'w1' },
    );

    expect(spaces.getUserSpaceIdsQuery).toHaveBeenCalledWith('u1');
    expect(permissions.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['p1', 'p2'],
      userId: 'u1',
      spaceId: undefined,
    });
    expect(result.items).toEqual([{ id: 'allowed', pageId: 'p2' }]);
    expect(query.where).toHaveBeenCalledWith(
      'attachments.workspaceId',
      '=',
      'w1',
    );
    expect(query.where).toHaveBeenCalledWith(
      'attachments.type',
      '=',
      'file',
    );
    expect(query.nestedQueries[0].select).toHaveBeenCalledWith([
      'spaces.id',
      'spaces.name',
      'spaces.slug',
      'spaces.logo',
    ]);
  });

  it('does not search attachment content without a query', async () => {
    const service = new SearchService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.searchAttachments(
        { query: '  ' } as any,
        { userId: 'u1', workspaceId: 'w1' },
      ),
    ).resolves.toEqual({ items: [] });
  });
});
