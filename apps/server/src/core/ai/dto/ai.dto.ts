import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Flat per-request retrieval overrides (docmost-rag-v1 contract 12). rerankModel
 * is an optional nullable workspace-authorized model reference: omission keeps
 * the stored explicit model, while an explicit null (or blank) CLEARS it and
 * then runs the same workspace-authorized server-side default resolution —
 * null is NOT a disable switch. A non-blank reference is validated
 * server-side and resolved against the workspace's own provider configuration.
 */
export class RagRetrievalOverridesDto {
  @IsOptional() @IsInt() @Min(1) @Max(200) recallCount?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) vectorThreshold?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) keywordThreshold?: number;
  @IsOptional() @IsString() @MaxLength(200) rerankModel?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(200) rerankTopK?: number;
  @IsOptional() @IsNumber() @Min(-10) @Max(10) rerankThreshold?: number;
}

export class UpdateAiProviderDto {
  @IsString()
  @IsIn(['openai', 'openai-compatible', 'gemini', 'ollama'])
  driver: string;
  @IsString() @MaxLength(2048) baseUrl: string;
  @IsString() @MaxLength(120) chatModel: string;
  @IsOptional() @IsString() @MaxLength(120) embeddingModel?: string;
  /**
   * Owner-configured default rerank model on the workspace's own provider
   * settings: the workspace-authorized fallback when a retrieval flow has no
   * explicit rerankModel. Omission keeps the stored reference; null or a
   * blank value clears it.
   */
  @IsOptional() @IsString() @MaxLength(120) rerankModel?: string | null;
  @IsOptional() @IsString() @MaxLength(4096) apiKey?: string;
}

export class CreateChatDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}

export class ChatIdDto {
  @IsString() chatId: string;
}

export class CreateChatMessageDto extends ChatIdDto {
  @IsOptional() @IsString() @MaxLength(100) requestId?: string;
  @IsString() @MaxLength(16000) content: string;
  @IsOptional() @IsArray() @IsString({ each: true }) attachmentIds?: string[];

  // Optional retrieval scope: the chat runs its normal hybrid flow within
  // this space when present.
  @IsOptional() @IsString() spaceId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RagRetrievalOverridesDto)
  retrieval?: RagRetrievalOverridesDto;
}

export class CancelChatDto extends ChatIdDto {
  @IsString() @MaxLength(100) requestId: string;
}

export class SemanticSearchDto {
  @IsString() @MaxLength(500) query: string;
  @IsOptional() @IsString() spaceId?: string;
  @IsOptional() @IsBoolean() titleOnly?: boolean;

  @IsOptional()
  @IsIn(['semantic', 'keyword', 'hybrid'])
  mode?: 'semantic' | 'keyword' | 'hybrid';

  @IsOptional()
  @ValidateNested()
  @Type(() => RagRetrievalOverridesDto)
  retrieval?: RagRetrievalOverridesDto;
}
