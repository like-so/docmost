import { AiIndexService } from './ai-index.service';
import { AiProcessor } from './ai.processor';
import { QueueJob } from '../../integrations/queue/constants';

describe('AiIndexService deterministic embedding', () => {
  it('produces stable normalized vectors without a vendor provider', () => {
    const service = new AiIndexService({} as any) as any;
    const first = service.embed('Security policy review');
    const second = service.embed('Security policy review');
    expect(first).toEqual(second);
    expect(Math.hypot(...first)).toBeCloseTo(1);
  });

  it('does not remove embeddings after search is re-enabled', async () => {
    const db = { deleteFrom: jest.fn() };
    const service = new AiIndexService(db as any) as any;
    jest.spyOn(service, 'isSearchEnabled').mockResolvedValue(true);

    await service.removeWorkspaceIfSearchDisabled('workspace');

    expect(db.deleteFrom).not.toHaveBeenCalled();
  });
});

describe('AiProcessor lifecycle', () => {
  it('indexes create/update/restore and removes deleted pages', async () => {
    const indexService = {
      indexPages: jest.fn(),
      removePages: jest.fn(),
      reindexWorkspace: jest.fn(),
      removeWorkspaceIfSearchDisabled: jest.fn(),
      removeSpace: jest.fn(),
    };
    const processor = new AiProcessor(indexService as any);
    await processor.process({
      name: QueueJob.PAGE_UPDATED,
      data: { pageIds: ['page'], workspaceId: 'workspace' },
    } as any);
    await processor.process({
      name: QueueJob.PAGE_SOFT_DELETED,
      data: { pageIds: ['page'], workspaceId: 'workspace' },
    } as any);
    expect(indexService.indexPages).toHaveBeenCalledWith(['page'], 'workspace');
    expect(indexService.removePages).toHaveBeenCalledWith(
      ['page'],
      'workspace',
    );
  });

  it('reindexes moved active pages so their current space metadata is stored', async () => {
    const indexService = {
      indexPages: jest.fn(),
      removePages: jest.fn(),
      reindexWorkspace: jest.fn(),
      removeWorkspaceIfSearchDisabled: jest.fn(),
      removeSpace: jest.fn(),
    };
    const processor = new AiProcessor(indexService as any);

    await processor.process({
      name: QueueJob.PAGE_MOVED_TO_SPACE,
      data: { pageIds: ['root', 'child'], spaceId: 'new-space', workspaceId: 'workspace' },
    } as any);

    expect(indexService.indexPages).toHaveBeenCalledWith(
      ['root', 'child'],
      'workspace',
    );
  });

  it('reindexes enabled workspaces and removes disabled or deleted indexes', async () => {
    const indexService = {
      indexPages: jest.fn(),
      removePages: jest.fn(),
      reindexWorkspace: jest.fn(),
      removeWorkspaceIfSearchDisabled: jest.fn(),
      removeWorkspace: jest.fn(),
      removeSpace: jest.fn(),
    };
    const processor = new AiProcessor(indexService as any);
    await processor.process({
      name: QueueJob.WORKSPACE_CREATE_EMBEDDINGS,
      data: { workspaceId: 'workspace' },
    } as any);
    await processor.process({
      name: QueueJob.WORKSPACE_DELETE_EMBEDDINGS,
      data: { workspaceId: 'workspace' },
    } as any);
    await processor.process({
      name: QueueJob.SPACE_DELETED,
      data: { workspaceId: 'workspace', spaceId: 'space' },
    } as any);
    expect(indexService.reindexWorkspace).toHaveBeenCalledWith('workspace');
    expect(indexService.removeWorkspaceIfSearchDisabled).toHaveBeenCalledWith(
      'workspace',
    );
    expect(indexService.removeSpace).toHaveBeenCalledWith('space', 'workspace');
  });
});
