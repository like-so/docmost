import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { JsonValue } from '@docmost/db/types/db';

export class CreateTemplateDto {
  @IsString()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  content?: JsonValue;
}

export class UpdateTemplateDto extends CreateTemplateDto {
  @IsUUID()
  templateId: string;
}

export class TemplateIdDto {
  @IsUUID()
  templateId: string;
}

export class InstantiateTemplateDto extends TemplateIdDto {
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}
