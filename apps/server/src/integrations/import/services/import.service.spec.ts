jest.mock('mammoth', () => ({ convertToHtml: jest.fn() }));
jest.mock('@docmost/pdf-inspector', () => ({
  extractPagesMarkdown: jest.fn(),
}));
jest.mock('../utils/import-formatter', () => ({
  normalizeImportHtml: jest.fn(),
}));

import { BadRequestException } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { extractPagesMarkdown } from '@docmost/pdf-inspector';
import { ImportService } from './import.service';

describe('ImportService document conversion', () => {
  const service = Object.create(ImportService.prototype) as ImportService;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(service, 'processHTML').mockResolvedValue({ type: 'doc' });
    jest.spyOn(service, 'processMarkdown').mockResolvedValue({ type: 'doc' });
  });

  it('converts DOCX with the installed mammoth converter', async () => {
    jest.mocked(mammoth.convertToHtml).mockResolvedValue({
      value: '<h1>Imported</h1>',
      messages: [],
    } as any);

    await service.processDocx(Buffer.from('docx'));

    expect(service.processHTML).toHaveBeenCalledWith('<h1>Imported</h1>');
  });

  it('converts extractable PDF pages through Markdown normalization', async () => {
    jest.mocked(extractPagesMarkdown).mockReturnValue({
      pages: [{ markdown: '# Imported', page: 0, needsOcr: false }],
    } as any);

    await service.processPdf(Buffer.from('pdf'));

    expect(service.processMarkdown).toHaveBeenCalledWith('# Imported');
  });

  it('rejects PDFs without extractable content', async () => {
    jest.mocked(extractPagesMarkdown).mockReturnValue({ pages: [] } as any);

    await expect(service.processPdf(Buffer.from('pdf'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
