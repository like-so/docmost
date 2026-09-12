import { BadRequestException } from '@nestjs/common';
import { AttachmentService } from './attachment.service';

describe('AttachmentService chat upload policy', () => {
  it('allows only text and document content that chat can safely extract', () => {
    const service = Object.create(AttachmentService.prototype) as AttachmentService;

    expect(() =>
      (service as any).validateChatFile({
        fileExtension: '.txt',
        mimeType: 'text/plain',
      }),
    ).not.toThrow();
    expect(() =>
      (service as any).validateChatFile({
        fileExtension: '.exe',
        mimeType: 'application/octet-stream',
      }),
    ).toThrow(BadRequestException);
  });
});
