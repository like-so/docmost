import { BadRequestException } from '@nestjs/common';
import { csvCell, MAX_CSV_ROWS, parseCsv } from './base-csv';

describe('parseCsv limits', () => {
  it('rejects row counts beyond the bounded import limit', () => {
    const csv = Array.from({ length: MAX_CSV_ROWS + 1 }, () => 'value').join('\n');
    expect(() => parseCsv(csv)).toThrow(BadRequestException);
  });
});

describe('base CSV', () => {
  it('parses quoted commas and escaped quotes', () => {
    expect(parseCsv('Name,Note\nAlpha,"a, ""quoted"" value"')).toEqual([['Name', 'Note'], ['Alpha', 'a, "quoted" value']]);
  });
  it('converts typed cells and rejects invalid values', () => {
    expect(csvCell('1.5', 'number')).toBe(1.5);
    expect(csvCell('false', 'boolean')).toBe(false);
    expect(() => csvCell('no', 'boolean')).toThrow(BadRequestException);
  });
});
