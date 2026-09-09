import { describe, expect, it } from 'vitest';
import { groupRows } from './base-view';

describe('base view grouping', () => {
  it('groups kanban rows by the selected property and keeps unassigned rows', () => {
    const groups = groupRows([
      { id: 'one', cells: { status: 'Todo' }, position: 'a' },
      { id: 'two', cells: {}, position: 'b' },
      { id: 'three', cells: { status: 'Todo' }, position: 'c' },
    ], 'status');
    expect(groups.get('Todo')?.map((row) => row.id)).toEqual(['one', 'three']);
    expect(groups.get('Unassigned')?.map((row) => row.id)).toEqual(['two']);
  });
});
