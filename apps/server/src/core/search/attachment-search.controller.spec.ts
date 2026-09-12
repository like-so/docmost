import { AttachmentSearchController } from './search.controller';

describe('AttachmentSearchController', () => {
  it('passes the authenticated user and workspace to the permission-filtered service', async () => {
    const searchService = { searchAttachments: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new AttachmentSearchController(searchService as any);

    await controller.searchAttachments({ query: 'contract' } as any, { id: 'u1' } as any, { id: 'w1' } as any);

    expect(searchService.searchAttachments).toHaveBeenCalledWith(
      { query: 'contract' },
      { userId: 'u1', workspaceId: 'w1' },
    );
  });
});
