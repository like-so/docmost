import { describe, expect, it } from 'vitest';
import { exportFormats } from './export-modal';

describe('export formats', () => {
  it('offers a PDF export for pages', () => {
    expect(exportFormats(true)).toContainEqual({
      value: 'pdf',
      label: 'PDF (.pdf)',
    });
  });
});
