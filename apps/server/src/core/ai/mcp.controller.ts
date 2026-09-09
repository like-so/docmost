import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { EnforceMcpOauth } from '../../common/decorators/enforce-mcp-oauth.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SearchService } from '../search/search.service';

@UseGuards(JwtAuthGuard)
@Controller('mcp')
export class McpController {
  constructor(private readonly searchService: SearchService) {}

  @Post()
  @OAuthScope('read')
  @EnforceMcpOauth()
  @HttpCode(200)
  async call(
    @Body()
    request: {
      id?: string | number;
      method: string;
      params?: {
        name?: string;
        arguments?: { query?: string; spaceId?: string };
      };
    },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if ((workspace.settings as { ai?: { mcp?: boolean } })?.ai?.mcp !== true)
      throw new ForbiddenException('MCP is disabled');
    const result = await this.dispatch(request, user, workspace);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  }

  private async dispatch(
    request: {
      method: string;
      params?: {
        name?: string;
        arguments?: { query?: string; spaceId?: string };
      };
    },
    user: User,
    workspace: Workspace,
  ) {
    if (request.method === 'initialize')
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'docmost', version: '0.96.0' },
      };
    if (request.method === 'tools/list')
      return {
        tools: [
          {
            name: 'search_workspace',
            description: 'Search pages the authenticated user can read',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                spaceId: { type: 'string' },
              },
              required: ['query'],
            },
          },
        ],
      };
    if (
      request.method === 'tools/call' &&
      request.params?.name === 'search_workspace'
    ) {
      const query = request.params.arguments?.query?.trim();
      if (!query || query.length > 500)
        throw new ForbiddenException('Invalid search query');
      const response = await this.searchService.searchPage(
        {
          query,
          spaceId: request.params.arguments?.spaceId,
          limit: 25,
          offset: 0,
        },
        { userId: user.id, workspaceId: workspace.id },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(response.items) }],
      };
    }
    throw new ForbiddenException('Unsupported MCP method');
  }
}
