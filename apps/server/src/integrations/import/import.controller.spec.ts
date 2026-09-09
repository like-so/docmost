jest.mock('./services/import.service', () => ({
  ImportService: class ImportService {},
}));

import { ImportController } from './import.controller';

describe('ImportController', () => {
  it('uses the configured regular-document import limit in its upload error', async () => {
    const controller = new ImportController(
      {} as any,
      {} as any,
      { getFileImportSizeLimit: jest.fn().mockReturnValue('7mb') } as any,
      {} as any,
    );
    const request = {
      file: jest.fn().mockRejectedValue({ statusCode: 413, message: 'too large' }),
    };

    await expect(controller.importPage(request, {} as any, {} as any)).rejects.toThrow('File too large. Exceeds the 7mb import limit');
  });
});
