import { BadRequestException } from '@nestjs/common';
import { evaluateFormula } from './base-formula';

describe('base formulas', () => {
  const ids = new Map([['Cost', 'cost'], ['Count', 'count'], ['Name', 'name'], ['Due', 'due']]);
  it('evaluates numeric properties using precedence and parentheses', () => {
    expect(evaluateFormula('({Cost} + 2) * {Count}', { cost: 3, count: 4 }, ids)).toBe(20);
  });
  it('returns text and booleans without executing input as code', () => {
    expect(evaluateFormula('{Name} & " task"', { name: 'Plan' }, ids)).toBe('Plan task');
    expect(evaluateFormula('{Count} >= 3', { count: 3 }, ids)).toBe(true);
    expect(() => evaluateFormula('process.exit()', {}, ids)).toThrow(BadRequestException);
  });
  it('returns ISO dates and supports date reference day arithmetic', () => {
    expect(evaluateFormula('DATE("2026-09-09") + 2', {}, ids)).toBe('2026-09-11');
    expect(evaluateFormula('{Due} < DATE("2026-10-01")', { due: '2026-09-09' }, ids)).toBe(true);
  });
});
