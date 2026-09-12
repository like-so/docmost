import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { JsonObject } from '@docmost/db/types/db';

const baseTypes = [
  'text',
  'longText',
  'number',
  'boolean',
  'date',
  'select',
  'multiSelect',
  'person',
  'files',
  'formula',
] as const;

class BasePageDto {
  @IsString() @MaxLength(64) pageId: string;
}

class BaseMutationDto extends BasePageDto {
  @IsInt() @Min(1) @Max(2147483647) version: number;
}

export class CreateBaseDto {
  @IsString() @MaxLength(64) parentPageId: string;
  @IsOptional() @IsIn(['table', 'kanban']) template?: string;
}

export class BasePropertyDto extends BaseMutationDto {
  @IsString() @MaxLength(100) name: string;
  @IsIn(baseTypes) type: (typeof baseTypes)[number];
  @IsOptional() @IsString() @MaxLength(2000) formula?: string;
}

export class UpdateBasePropertyDto extends BaseMutationDto {
  @IsString() @MaxLength(64) propertyId: string;
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsIn(baseTypes) type?: (typeof baseTypes)[number];
  @IsOptional() @IsString() @MaxLength(2000) formula?: string;
  @IsOptional() @IsString() @MaxLength(64) position?: string;
}

export class BaseRowDto extends BaseMutationDto {
  @IsObject() cells: JsonObject;
}

export class UpdateBaseRowDto extends BaseRowDto {
  @IsString() @MaxLength(64) rowId: string;
  @IsOptional() @IsString() @MaxLength(64) position?: string;
}

export class BaseCsvDto extends BaseMutationDto {
  @IsString() @MaxLength(5_000_000) csv: string;
}

export class DeletePropertyDto extends BaseMutationDto {
  @IsString() @MaxLength(64) propertyId: string;
}

export class DeleteRowDto extends BaseMutationDto {
  @IsString() @MaxLength(64) rowId: string;
}

export class BaseViewDto extends BaseMutationDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsIn(['table', 'kanban']) type?: string;
  @IsOptional() @IsObject() config?: JsonObject;
  @IsOptional() @IsString() @MaxLength(64) position?: string;
}

export class DeleteViewDto extends BaseMutationDto {
  @IsString() @MaxLength(64) viewId: string;
}
