import { describe, expect, it } from 'vitest';
import { getImportOutcome } from "./page-import.utils";

describe('getImportOutcome', () => {
  it('identifies complete and partial imports separately', () => {
    expect(getImportOutcome(2, 0)).toBe('complete');
    expect(getImportOutcome(2, 1)).toBe('partial');
  });

  it('reports an all-failed import', () => {
    expect(getImportOutcome(0, 2)).toBe('failed');
  });
});
