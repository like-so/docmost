import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
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

  @IsIn(['semantic', 'keyword', 'hybrid'])
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

export class RagIndexingStrategyDto {
  @IsBoolean()
  vectorEnabled: boolean;

  @IsBoolean()
  keywordEnabled: boolean;
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

  // Optional: legacy profiles omit it and keep their exact profile hash.
  @IsOptional()
  @ValidateNested()
  @Type(() => RagIndexingStrategyDto)
  indexingStrategy?: RagIndexingStrategyDto;
}

export class RagSettingsUpdateDto {
  @IsBoolean()
  enabled: boolean;

  @ValidateNested()
  @Type(() => RagIndexProfileConfigDto)
  indexProfileConfig: RagIndexProfileConfigDto;
}

/**
 * Owner-controlled retrieval settings (docmost-rag-v1 contract 13). Defaults
 * follow the pinned reference; every field is optional in the update payload
 * and invalid or missing fields fall back to defaults server-side.
 */
export class RagRetrievalSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  recallCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  vectorThreshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  keywordThreshold?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  rerankModel?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  rerankTopK?: number;

  @IsOptional()
  @IsNumber()
  @Min(-10)
  @Max(10)
  rerankThreshold?: number;
}

/**
 * Owner-controlled chat retrieval settings: ALL RetrievalConfig fields (chat
 * carries independent defaults for recall and rerank) plus the
 * rewrite/expansion extras.
 */
export class RagChatRetrievalSettingsDto extends RagRetrievalSettingsDto {
  @IsOptional()
  @IsBoolean()
  rewriteEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  expansionEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  queryUnderstandingModel?: string | null;

  @IsOptional()
  @IsString()
  rewriteSystemPrompt?: string;

  @IsOptional()
  @IsString()
  rewriteUserPrompt?: string;
}

export class RagRetrievalSettingsUpdateDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => RagRetrievalSettingsDto)
  search?: RagRetrievalSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RagChatRetrievalSettingsDto)
  chat?: RagChatRetrievalSettingsDto;
}
