import { isImportMime } from './file.utils';

describe('isImportMime', () => {
  it('accepts only MIME types appropriate for each document import', () => {
    expect(isImportMime('.pdf', 'application/pdf')).toBe(true);
    expect(isImportMime('.docx', 'application/zip')).toBe(true);
    expect(isImportMime('.html', 'text/html')).toBe(true);
    expect(isImportMime('.pdf', 'text/plain')).toBe(false);
    expect(isImportMime('.md', 'application/pdf')).toBe(false);
  });
});
