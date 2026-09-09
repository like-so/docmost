import { describe, expect, it, vi } from 'vitest';
import api from '@/lib/api-client';
import { searchAttachments } from './search-service';

vi.mock('@/lib/api-client', () => ({
  default: { post: vi.fn() },
}));

describe('searchAttachments', () => {
  it('uses the authenticated attachment-search endpoint contract', async () => {
    vi.mocked(api.post).mockResolvedValue({
      data: { items: [{ id: 'a1' }] },
    } as any);

    await expect(searchAttachments({ query: 'contract' })).resolves.toEqual([
      { id: 'a1' },
    ]);

    expect(api.post).toHaveBeenCalledWith('/search-attachments', {
      query: 'contract',
    });
  });
});
