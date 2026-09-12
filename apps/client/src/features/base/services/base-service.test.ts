import { describe, expect, it, vi } from 'vitest';
import api from '@/lib/api-client';
import { addBaseRow, saveBaseView } from './base-service';

vi.mock('@/lib/api-client', () => ({
  default: { post: vi.fn() },
}));

describe('base service', () => {
  it('sends the current base version when creating a row', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { id: 'row' } } as any);

    await expect(addBaseRow('page', {}, 4)).resolves.toEqual({ id: 'row' });

    expect(api.post).toHaveBeenCalledWith('/bases/rows/create', {
      pageId: 'page',
      cells: {},
      version: 4,
    });
  });

  it('sends the current base version when saving a view', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { id: 'view' } } as any);

    await expect(
      saveBaseView('page', undefined, 'Table', 'table', {}, 4),
    ).resolves.toEqual({ id: 'view' });

    expect(api.post).toHaveBeenCalledWith('/bases/views/save', {
      pageId: 'page',
      id: undefined,
      name: 'Table',
      type: 'table',
      config: {},
      version: 4,
    });
  });
});
