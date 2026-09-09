import { TransclusionService } from '../transclusion.service';

describe('TransclusionService lookupWithAccessSet', () => {
  it('does not load or return content for a source excluded by effective access', async () => {
    const transclusions = { findManyByPageAndTransclusion: jest.fn().mockResolvedValue([]) };
    const pages = { findManyByIds: jest.fn().mockResolvedValue([]) };
    const service = new TransclusionService(
      {} as any,
      transclusions as any,
      {} as any,
      pages as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.lookupWithAccessSet(
      [{ sourcePageId: 'restricted', transclusionId: 'node' }],
      new Set(),
      'workspace',
    );

    expect(result.items).toEqual([
      { sourcePageId: 'restricted', transclusionId: 'node', status: 'no_access' },
    ]);
    expect(transclusions.findManyByPageAndTransclusion).toHaveBeenCalledWith([], 'workspace');
    expect(pages.findManyByIds).toHaveBeenCalledWith([], { workspaceId: 'workspace' });
  });
});
