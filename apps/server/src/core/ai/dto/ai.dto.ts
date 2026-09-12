import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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
}

export class CancelChatDto extends ChatIdDto {
  @IsString() @MaxLength(100) requestId: string;
}

export class SemanticSearchDto {
  @IsString() @MaxLength(500) query: string;
  @IsOptional() @IsString() spaceId?: string;
  @IsOptional() @IsBoolean() titleOnly?: boolean;
}
