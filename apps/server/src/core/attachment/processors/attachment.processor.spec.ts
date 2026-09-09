import { AttachmentProcessor } from './attachment.processor';
import { QueueJob } from '../../../integrations/queue/constants';

describe('AttachmentProcessor', () => {
  it('indexes attachment content for attachment index jobs', async () => {
    const attachmentService = { indexAttachmentContent: jest.fn() };
    const processor = new AttachmentProcessor(attachmentService as any);

    await processor.process({
      name: QueueJob.ATTACHMENT_INDEX_CONTENT,
      data: { attachmentId: 'attachment' },
    } as any);

    expect(attachmentService.indexAttachmentContent).toHaveBeenCalledWith(
      'attachment',
    );
  });
});
