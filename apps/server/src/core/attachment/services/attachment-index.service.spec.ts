jest.mock('mammoth', () => ({ extractRawText: jest.fn() }));
jest.mock('@docmost/pdf-inspector', () => ({ extractText: jest.fn() }));

import * as mammoth from 'mammoth';
import { extractText } from '@docmost/pdf-inspector';
import { AttachmentService } from './attachment.service';

describe('AttachmentService content indexing', () => {
  const attachment = {
    id: 'attachment',
    type: 'file',
    fileExt: '.docx',
    filePath: 'attachments/document.docx',
  };

  function createService(overrides: Record<string, unknown> = {}) {
    const storage = { read: jest.fn().mockResolvedValue(Buffer.from('file')) };
    const repo = {
      findById: jest.fn().mockResolvedValue(attachment),
      updateSearchContent: jest.fn(),
      ...overrides,
    };
    const service = new AttachmentService(
      storage as any,
      repo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn() } as any,
    );
    return { service, storage, repo };
  }

  it('extracts DOCX text and replaces the indexed content', async () => {
    jest.mocked(mammoth.extractRawText).mockResolvedValue({ value: 'doc text', messages: [] });
    const { service, repo } = createService();

    await service.indexAttachmentContent('attachment');

    expect(repo.updateSearchContent).toHaveBeenCalledWith('attachment', 'doc text');
  });

  it('indexes TXT and PDF content through their installed extractors', async () => {
    const { service, storage, repo } = createService({
      findById: jest
        .fn()
        .mockResolvedValueOnce({ ...attachment, fileExt: '.txt' })
        .mockResolvedValueOnce({ ...attachment, fileExt: '.pdf' }),
    });
    jest.mocked(extractText).mockReturnValue('pdf text');
    storage.read.mockResolvedValueOnce(Buffer.from('plain text'));

    await service.indexAttachmentContent('text');
    await service.indexAttachmentContent('pdf');

    expect(repo.updateSearchContent).toHaveBeenNthCalledWith(
      1,
      'attachment',
      'plain text',
    );
    expect(repo.updateSearchContent).toHaveBeenNthCalledWith(
      2,
      'attachment',
      'pdf text',
    );
  });

  it('does not index deleted or unsupported attachments', async () => {
    const { service, storage, repo } = createService({
      findById: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ ...attachment, fileExt: '.png' }),
    });

    await service.indexAttachmentContent('deleted');
    await service.indexAttachmentContent('image');

    expect(storage.read).not.toHaveBeenCalled();
    expect(repo.updateSearchContent).not.toHaveBeenCalled();
  });

  it('does not index attachments outside the file and chat types', async () => {
    const { service, storage, repo } = createService({
      findById: jest
        .fn()
        .mockResolvedValue({ ...attachment, type: 'space-icon' }),
    });

    await service.indexAttachmentContent('icon');

    expect(storage.read).not.toHaveBeenCalled();
    expect(repo.updateSearchContent).not.toHaveBeenCalled();
  });
});
