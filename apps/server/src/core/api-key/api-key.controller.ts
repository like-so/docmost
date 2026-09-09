import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { User } from '@docmost/db/types/entity.types';
import { ApiKeyService } from './api-key.service';

class CreateApiKeyDto {
  @IsString() @MaxLength(100) name: string;
  @IsArray() @IsString({ each: true }) scopes: string[];
  @IsOptional() @IsDateString() expiresAt?: string;
}

class RenameApiKeyDto {
  @IsString() @MaxLength(100) name: string;
}

@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  list(@AuthUser() user: User) {
    return this.apiKeyService.list(user);
  }

  @Post()
  async create(@AuthUser() user: User, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.create(
      user,
      dto.name,
      dto.scopes,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    );
  }

  @Patch(':id')
  async rename(
    @AuthUser() user: User,
    @Param('id') id: string,
    @Body() dto: RenameApiKeyDto,
  ) {
    await this.apiKeyService.rename(user, id, dto.name);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@AuthUser() user: User, @Param('id') id: string) {
    await this.apiKeyService.revoke(user, id);
  }

  @Get('admin')
  listWorkspace(@AuthUser() user: User) {
    return this.apiKeyService.listWorkspace(user);
  }

  @Patch('admin/:id')
  async renameWorkspace(
    @AuthUser() user: User,
    @Param('id') id: string,
    @Body() dto: RenameApiKeyDto,
  ) {
    await this.apiKeyService.renameWorkspace(user, id, dto.name);
  }

  @Delete('admin/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeWorkspace(@AuthUser() user: User, @Param('id') id: string) {
    await this.apiKeyService.revokeWorkspace(user, id);
  }
}
