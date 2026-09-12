import { BadRequestException } from '@nestjs/common';

export const MAX_CSV_BYTES = 5_000_000;
export const MAX_CSV_ROWS = 10_000;
export const MAX_CSV_COLUMNS = 100;
export const MAX_CSV_CELL = 25_000;

export function parseCsv(input: string): string[][] {
  if (Buffer.byteLength(input, 'utf8') > MAX_CSV_BYTES)
    throw new BadRequestException('CSV is too large');
  const rows: string[][] = [[]];
  let value = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { rows[rows.length - 1].push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      rows[rows.length - 1].push(value); rows.push([]); value = '';
    } else value += char;
  }
  if (quoted) throw new BadRequestException('Malformed CSV');
  rows[rows.length - 1].push(value);
  const values = rows.filter((row) => row.some((cell) => cell !== ''));
  if (values.length > MAX_CSV_ROWS)
    throw new BadRequestException('CSV has too many rows');
  if (
    values.some(
      (row) =>
        row.length > MAX_CSV_COLUMNS ||
        row.some((cell) => cell.length > MAX_CSV_CELL),
    )
  )
    throw new BadRequestException('CSV is too large');
  return values;
}

export function csvCell(value: string, type: string): string | number | boolean | null {
  if (value === '') return null;
  if (type === 'number') { const number = Number(value); if (!Number.isFinite(number)) throw new BadRequestException('Invalid number in CSV'); return number; }
  if (type === 'boolean') { if (value === 'true') return true; if (value === 'false') return false; throw new BadRequestException('Invalid boolean in CSV'); }
  return value;
}
