import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRole } from '../../../../common/helpers/types/permission';
import {
  RagPageDto,
  RagRetrieveDto,
  RagRetrievalSettingsUpdateDto,
  RagSettingsUpdateDto,
} from './rag-http.dto';
import { RagSettingsService } from './rag-settings.service';
import { RagStatusService } from './rag-status.service';
import { RagReindexService } from './rag-reindex.service';
import { RagRetrieverService } from '../retrieval/rag-retriever.service';

/**
 * HTTP adapters of docmost-rag-v1 contract 13. Owner-only for the two
 * settings routes; status requires view and reindex requires edit
 * permission (checked in their services); retrieve requires only workspace
 * authentication and rechecks authorization inside the retriever.
 */
@UseGuards(JwtAuthGuard)
@Controller('ai/rag')
export class RagHttpController {
  constructor(
    private readonly settingsService: RagSettingsService,
    private readonly statusService: RagStatusService,
    private readonly reindexService: RagReindexService,
    private readonly retrieverService: RagRetrieverService,
  ) {}

  @Post('settings')
  @HttpCode(HttpStatus.OK)
  getSettings(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.requireOwner(user);
    return this.settingsService.getSettings(workspace);
  }

  @Post('settings/update')
  @HttpCode(HttpStatus.OK)
  updateSettings(
    @Body() input: RagSettingsUpdateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.settingsService.updateSettings(workspace, {
      enabled: input.enabled,
      indexProfileConfig: {
        ...input.indexProfileConfig,
        embedding: {
          ...input.indexProfileConfig.embedding,
          endpointIdentity:
            input.indexProfileConfig.embedding.endpointIdentity ?? null,
          tokenizerId: input.indexProfileConfig.embedding.tokenizerId ?? null,
        },
      },
    });
  }

  @Get('retrieval-settings')
  getRetrievalSettings(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.settingsService.getRetrievalSettings(workspace);
  }

  @Post('retrieval-settings/update')
  @HttpCode(HttpStatus.OK)
  updateRetrievalSettings(
    @Body() input: RagRetrievalSettingsUpdateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireOwner(user);
    return this.settingsService.updateRetrievalSettings(workspace, {
      search: input.search as Record<string, unknown> | undefined,
      chat: input.chat as Record<string, unknown> | undefined,
    });
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  status(
    @Body() input: RagPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.statusService.getStatus(user, workspace, input.pageId);
  }

  @Post('reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  reindex(
    @Body() input: RagPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.reindexService.reindex(user, workspace, input.pageId);
  }

  @Post('retrieve')
  @HttpCode(HttpStatus.OK)
  retrieve(
    @Body() input: RagRetrieveDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.retrieverService.retrieve(
      { userId: user.id, workspaceId: workspace.id },
      {
        query: input.query.trim(),
        spaceId: input.spaceId,
        pageIds: input.pageIds,
        mode: input.mode,
        limit: input.limit,
      },
    );
  }

  private requireOwner(user: User) {
    if (user.role !== UserRole.OWNER) throw new ForbiddenException();
  }
}
