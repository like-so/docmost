import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { AiService } from './ai.service';
import {
  ChatIdDto,
  CancelChatDto,
  CreateChatDto,
  CreateChatMessageDto,
  SemanticSearchDto,
  UpdateAiProviderDto,
} from './dto/ai.dto';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('settings')
  @HttpCode(HttpStatus.OK)
  getSettings(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.requireOwner(user);
    return this.aiService.getProvider(workspace);
  }

  @Post('settings/update')
  @HttpCode(HttpStatus.OK)
  updateSettings(
    @Body() input: UpdateAiProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.aiService.updateProvider(workspace, input);
  }

  @Post('chats/list')
  @HttpCode(HttpStatus.OK)
  listChats(@AuthUser() user: User) {
    return this.aiService.listChats(user);
  }

  @Post('chats/create')
  @HttpCode(HttpStatus.OK)
  createChat(
    @Body() input: CreateChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiService.createChat(user, workspace, input.title);
  }

  @Post('chats/get')
  @HttpCode(HttpStatus.OK)
  getChat(@Body() input: ChatIdDto, @AuthUser() user: User) {
    return this.aiService.getChat(user, input.chatId);
  }

  @Post('chats/delete')
  @HttpCode(HttpStatus.OK)
  deleteChat(
    @Body() input: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiService.deleteChat(user, workspace, input.chatId);
  }

  @Post('chats/message')
  @HttpCode(HttpStatus.OK)
  addMessage(
    @Body() input: CreateChatMessageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiService.addMessage(
      user,
      workspace,
      input.chatId,
      input.content,
      input.attachmentIds,
      input.requestId,
    );
  }

  @Post('chats/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelChat(@Body() input: CancelChatDto, @AuthUser() user: User) {
    await this.aiService.cancel(user, input.chatId, input.requestId);
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  semanticSearch(
    @Body() input: SemanticSearchDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiService.semanticSearch(
      user,
      workspace,
      input.query,
      input.spaceId,
      input.titleOnly,
    );
  }

  private requireOwner(user: User) {
    if (user.role !== UserRole.OWNER) throw new ForbiddenException();
  }
}
