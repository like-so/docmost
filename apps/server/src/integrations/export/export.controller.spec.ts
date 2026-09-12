import { ForbiddenException } from '@nestjs/common';

jest.mock('./export.service', () => ({ ExportService: class ExportService {} }));

import { ExportController } from './export.controller';

describe('ExportController', () => {
  it('denies export before content generation when page access is denied', async () => {
    const exportService = { exportPages: jest.fn() };
    const pageAccess = {
      validateCanView: jest.fn().mockRejectedValue(new ForbiddenException()),
    };
    const controller = new ExportController(
      exportService as any,
      { findById: jest.fn().mockResolvedValue({ id: 'page', deletedAt: null }) } as any,
      {} as any,
      pageAccess as any,
      { log: jest.fn() } as any,
    );

    await expect(
      controller.exportPage(
        { pageId: 'page' } as any,
        { id: 'user' } as any,
        {} as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(exportService.exportPages).not.toHaveBeenCalled();
  });
});
