import { BadRequestException } from '@nestjs/common';
import { JsonObject, JsonValue } from '@docmost/db/types/db';

export function validateViewConfig(config: JsonObject): JsonObject {
  const sorts = config.sorts;
  if (sorts !== undefined && (!Array.isArray(sorts) || sorts.length > 5 || !sorts.every(validSort))) {
    throw new BadRequestException('A view supports at most five sort rules');
  }
  return config;
}

function validSort(value: JsonValue): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof value.propertyId === 'string' && (value.direction === 'asc' || value.direction === 'desc'));
}
