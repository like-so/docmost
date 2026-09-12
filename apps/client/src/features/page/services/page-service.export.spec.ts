import { describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({
  post: vi.fn().mockResolvedValue({
    data: new Blob(['pdf']),
    headers: { 'content-disposition': 'attachment; filename="page.pdf"' },
  }),
}));

vi.mock('@/lib/api-client', () => ({ default: { post } }));
vi.mock('file-saver', () => ({ saveAs: vi.fn() }));

import { exportPage } from './page-service';
import { ExportFormat } from '../types/page.types';

describe('page export', () => {
  it('sends a PDF format to the page export route', async () => {
    await exportPage({ pageId: 'page-id', format: ExportFormat.Pdf });
    expect(post).toHaveBeenCalledWith(
      '/pages/export',
      { pageId: 'page-id', format: 'pdf' },
      { responseType: 'blob' },
    );
  });
});
