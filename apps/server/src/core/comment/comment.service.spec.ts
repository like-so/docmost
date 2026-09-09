import { CommentService } from './comment.service';

describe('CommentService', () => {
  const comment = {
    id: 'comment',
    pageId: 'page',
    spaceId: 'space',
  } as any;

  it('sets or clears resolution ownership and emits an update', async () => {
    const commentRepo = {
      updateComment: jest.fn(),
      findById: jest.fn().mockResolvedValue(comment),
    };
    const wsService = { emitCommentEvent: jest.fn() };
    const service = new CommentService(
      commentRepo as any,
      {} as any,
      wsService as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.resolve(comment, { id: 'user' } as any, true);
    await service.resolve(comment, { id: 'user' } as any, false);

    expect(commentRepo.updateComment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ resolvedById: 'user', resolvedAt: expect.any(Date) }),
      'comment',
    );
    expect(commentRepo.updateComment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ resolvedById: null, resolvedAt: null }),
      'comment',
    );
    expect(wsService.emitCommentEvent).toHaveBeenCalledTimes(2);
  });
});
