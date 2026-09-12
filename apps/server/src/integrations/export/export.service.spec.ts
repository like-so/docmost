jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('@docmost/editor-ext', () => ({ htmlToMarkdown: jest.fn() }));
jest.mock('../../collaboration/collaboration.util', () => ({
  jsonToHtml: jest.fn(),
  jsonToNode: jest.fn(),
}));
jest.mock('../../common/helpers/prosemirror/utils', () => ({
  getAttachmentIds: jest.fn(() => ['owned', 'restricted']),
  getProsemirrorContent: jest.fn((content) => content),
}));

import { ExportService } from './export.service';

describe('ExportService attachment authorization', () => {
  const page = { id: 'page', spaceId: 'space', content: {} } as any;
  const attachments = [
    { id: 'owned', fileName: 'owned.txt', filePath: 'owned', pageId: 'page' },
    {
      id: 'restricted',
      fileName: 'restricted.txt',
      filePath: 'restricted',
      pageId: 'hidden',
    },
  ];

  function createService(accessible: string[]) {
    const query = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(attachments),
    };
    return new ExportService(
      {} as any,
      {
        filterAccessiblePageIds: jest.fn().mockResolvedValue(accessible),
      } as any,
      { selectFrom: jest.fn().mockReturnValue(query) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  it('does not export an attachment whose owning page is inaccessible', async () => {
    const service = createService(['page']);

    const visible = await (service as any).resolveAccessibleAttachments(
      { null: [page] },
      'user',
      false,
    );

    expect(visible.has('owned')).toBe(true);
    expect(visible.has('restricted')).toBe(false);
  });

  it('includes attachments for trusted internal exports only', async () => {
    const service = createService([]);

    const visible = await (service as any).resolveAccessibleAttachments(
      { null: [page] },
      undefined,
      true,
    );

    expect(visible.size).toBe(2);
  });
});
