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
 * Per-request retrieval knob overrides (actual search and chat). The rerank
 * model is resolved server-side and is not client-selectable.
 */
export class RagRetrievalOverridesDto {
  @IsOptional() @IsInt() @Min(1) @Max(200) recallCount?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) vectorThreshold?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) keywordThreshold?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) rerankTopK?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) rerankThreshold?: number;
}

export class ChatRetrievalOptionsDto {
  @IsOptional()
  @IsIn(['semantic', 'keyword', 'hybrid'])
  mode?: 'semantic' | 'keyword' | 'hybrid';

  @IsOptional() @IsString() spaceId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) pageIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => RagRetrievalOverridesDto)
  overrides?: RagRetrievalOverridesDto;
}

export class UpdateAiProviderDto {
  @IsString()
  @IsIn(['openai', 'openai-compatible', 'gemini', 'ollama'])
  driver: string;
  @IsString() @MaxLength(2048) baseUrl: string;
  @IsString() @MaxLength(120) chatModel: string;
  @IsOptional() @IsString() @MaxLength(120) embeddingModel?: string;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => ChatRetrievalOptionsDto)
  retrieval?: ChatRetrievalOptionsDto;
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
  overrides?: RagRetrievalOverridesDto;
}
