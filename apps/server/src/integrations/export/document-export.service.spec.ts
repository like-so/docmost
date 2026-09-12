import * as JSZip from 'jszip';
import { BadRequestException } from '@nestjs/common';
import * as undici from 'undici';
import { DocumentExportService } from './document-export.service';

describe('DocumentExportService', () => {
  const environment = {
    getGotenbergUrl: jest.fn(),
    getGotenbergRequestTimeoutMs: jest.fn().mockReturnValue(10_000),
  };
  const outbound = { lease: jest.fn() };
  const service = new DocumentExportService(environment as any, outbound as any);

  beforeEach(() => {
    outbound.lease.mockResolvedValue({ dispatcher: {}, release: jest.fn() });
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a standards-based DOCX archive without a converter', async () => {
    const output = await service.exportDocx(
      'Title',
      '<p>Hello &amp; goodbye</p>',
    );
    const zip = await JSZip.loadAsync(output);

    await expect(
      zip.file('word/document.xml').async('string'),
    ).resolves.toContain('Hello &amp; goodbye');
  });

  it('uses a guarded and bounded Gotenberg endpoint for PDF conversion', async () => {
    environment.getGotenbergUrl.mockReturnValue('http://converter:3000/');
    const fetchMock = jest.spyOn(undici, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')),
    } as any);

    await expect(service.exportPdf('<p>Hello</p>')).resolves.toEqual(
      Buffer.from('pdf'),
    );
    expect(outbound.lease).toHaveBeenCalledWith(
      'http://converter:3000/forms/chromium/convert/html',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://converter:3000/forms/chromium/convert/html',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });

  it('does not send remote, file, or metadata resources to the renderer', async () => {
    environment.getGotenbergUrl.mockReturnValue('http://converter:3000');
    const fetchMock = jest.spyOn(undici, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')),
    } as any);

    await service.exportPdf('<p style="color: red; background: url(http://169.254.169.254/latest/meta-data)">Hello</p><img src="file:///etc/passwd"><iframe src="http://127.0.0.1"></iframe><a href="data:text/html,boom">link</a>');

    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    const sent = await (form.get('files') as { text(): Promise<string> }).text();
    expect(sent).toContain('Hello');
    expect(sent).toContain('color: red');
    expect(sent).not.toMatch(/169\.254\.169\.254|127\.0\.0\.1|file:|data:|<img|<iframe|href=/i);
  });

  it('rejects PDF export when no converter is configured', async () => {
    environment.getGotenbergUrl.mockReturnValue(undefined);

    await expect(service.exportPdf('<p>Hello</p>')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
