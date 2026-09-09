import { BadRequestException } from '@nestjs/common';
import { validateViewConfig } from './base-view-config';

describe('base view config', () => {
  it('allows five persisted sort rules', () => {
    expect(validateViewConfig({ sorts: Array.from({ length: 5 }, (_, index) => ({ propertyId: String(index), direction: 'asc' })) })).toHaveProperty('sorts');
  });
  it('rejects a sixth or malformed sort rule', () => {
    expect(() => validateViewConfig({ sorts: Array.from({ length: 6 }, () => ({ propertyId: 'id', direction: 'asc' })) })).toThrow(BadRequestException);
    expect(() => validateViewConfig({ sorts: [{ propertyId: 'id', direction: 'up' }] })).toThrow(BadRequestException);
  });
});
