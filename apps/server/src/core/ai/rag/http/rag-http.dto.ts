import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RagRetrievalMode } from '../contracts';

export const RETRIEVE_QUERY_MAX_LENGTH = 500;
export const RETRIEVE_LIMIT_MAX = 50;
export const RETRIEVE_PAGE_IDS_MAX = 50;

export class RagPageDto {
  @IsUUID()
  pageId: string;
}

export class RagRetrieveDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(RETRIEVE_QUERY_MAX_LENGTH)
  query: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(RETRIEVE_PAGE_IDS_MAX)
  pageIds?: string[];

  @IsIn(['semantic', 'keyword'])
  mode: RagRetrievalMode;

  @IsInt()
  @Min(1)
  @Max(RETRIEVE_LIMIT_MAX)
  limit: number;
}

/**
 * Shape validation for the owner-supplied index profile config (docmost-rag-v1
 * contract 13). Semantic validation (supported combinations, real dimensions
 * and tokenizer limits, endpointIdentity resolution) belongs to the embedding
 * component's profile validator, not to this DTO.
 */
export class RagSourcePolicyDto {
  @IsArray()
  @IsString({ each: true })
  requiredMimeTypes: string[];

  @IsIn(['disabled', 'required'])
  imageInterpretation: 'disabled' | 'required';
}

export class RagEmbeddingConfigDto {
  @IsString()
  @MaxLength(120)
  driver: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  endpointIdentity?: string | null;

  @IsString()
  @MaxLength(200)
  model: string;

  @IsInt()
  @Min(1)
  dimensions: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  tokenizerId?: string | null;

  @IsInt()
  @Min(1)
  maxInputTokens: number;
}

export class RagIndexProfileConfigDto {
  @IsString()
  @MaxLength(60)
  parserVersion: string;

  @IsString()
  @MaxLength(60)
  chunkerVersion: string;

  @IsInt()
  @Min(1)
  maxChunkTokens: number;

  @IsInt()
  @Min(0)
  overlapTokens: number;

  @ValidateNested()
  @Type(() => RagSourcePolicyDto)
  sourcePolicy: RagSourcePolicyDto;

  @ValidateNested()
  @Type(() => RagEmbeddingConfigDto)
  embedding: RagEmbeddingConfigDto;
}

export class RagSettingsUpdateDto {
  @IsBoolean()
  enabled: boolean;

  @ValidateNested()
  @Type(() => RagIndexProfileConfigDto)
  indexProfileConfig: RagIndexProfileConfigDto;
}
