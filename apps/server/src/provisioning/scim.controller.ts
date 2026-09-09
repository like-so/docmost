import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ScimBearerGuard } from './guards/scim-bearer.guard';
import {
  ScimGroup,
  ScimResourceService,
  ScimUser,
} from './services/scim-resource.service';

@UseGuards(ScimBearerGuard)
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly resources: ScimResourceService) {}

  @Get('ServiceProviderConfig') config() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      filter: { supported: true, maxResults: 100 },
      pagination: { supported: true },
      bulk: { supported: false },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
    };
  }
  @Get('ResourceTypes') resourceTypes() {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      Resources: ['User', 'Group'].map((name) => ({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: name,
        name,
        endpoint: `/${name}s`,
        schema: `urn:ietf:params:scim:schemas:core:2.0:${name}`,
      })),
    };
  }
  @Get('Schemas') schemas() {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      Resources: ['User', 'Group'].map((name) => ({
        id: `urn:ietf:params:scim:schemas:core:2.0:${name}`,
        name,
      })),
    };
  }
  @Get('Users') users(
    @Req() req: any,
    @Query('startIndex') start?: string,
    @Query('count') count?: string,
    @Query('filter') filter?: string,
  ) {
    return this.resources.listUsers(
      req.scimWorkspaceId,
      Number(start) || 1,
      Number(count) || 100,
      filter,
    );
  }
  @Post('Users') createUser(@Req() req: any, @Body() input: ScimUser) {
    return this.resources.createUser(req.scimWorkspaceId, input);
  }
  @Get('Users/:id') user(@Req() req: any, @Param('id') id: string) {
    return this.resources.getUser(req.scimWorkspaceId, id);
  }
  @Put('Users/:id') replaceUser(
    @Req() req: any,
    @Param('id') id: string,
    @Body() input: ScimUser,
  ) {
    return this.resources.replaceUser(req.scimWorkspaceId, id, input);
  }
  @Patch('Users/:id') async patchUser(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    patch: { Operations: Array<{ op: string; path: string; value: unknown }> },
  ) {
    const current = await this.resources.getUser(req.scimWorkspaceId, id);
    const values = Object.fromEntries(
      (patch.Operations ?? [])
        .filter((op) => op.op.toLowerCase() === 'replace')
        .map((op) => [op.path, op.value]),
    );
    return this.resources.replaceUser(req.scimWorkspaceId, id, {
      userName: (values.userName as string) ?? current.userName,
      externalId: (values.externalId as string) ?? current.externalId,
      active: (values.active as boolean) ?? current.active,
      name: (values.name as ScimUser['name']) ?? current.name,
    });
  }
  @Delete('Users/:id') @HttpCode(204) deleteUser(
    @Req() req: any,
    @Param('id') id: string,
  ) {
    return this.resources.deleteUser(req.scimWorkspaceId, id);
  }
  @Get('Groups') groups(
    @Req() req: any,
    @Query('startIndex') start?: string,
    @Query('count') count?: string,
    @Query('filter') filter?: string,
  ) {
    const workspaceId = req.scimWorkspaceId;
    const startIndex = Number(start) || 1;
    const pageSize = Number(count) || 100;
    return filter
      ? this.resources.listGroups(workspaceId, startIndex, pageSize, filter)
      : this.resources.listGroups(workspaceId, startIndex, pageSize);
  }
  @Post('Groups') createGroup(@Req() req: any, @Body() input: ScimGroup) {
    return this.resources.createGroup(req.scimWorkspaceId, input);
  }
  @Get('Groups/:id') group(@Req() req: any, @Param('id') id: string) {
    return this.resources.getGroup(req.scimWorkspaceId, id);
  }
  @Put('Groups/:id') replaceGroup(
    @Req() req: any,
    @Param('id') id: string,
    @Body() input: ScimGroup,
  ) {
    return this.resources.replaceGroup(req.scimWorkspaceId, id, input);
  }
  @Patch('Groups/:id') patchGroup(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    patch: {
      Operations: Array<{ op: string; path?: string; value?: unknown }>;
    },
  ) {
    return this.resources.patchGroup(
      req.scimWorkspaceId,
      id,
      patch.Operations ?? [],
    );
  }
  @Delete('Groups/:id') @HttpCode(204) deleteGroup(
    @Req() req: any,
    @Param('id') id: string,
  ) {
    return this.resources.deleteGroup(req.scimWorkspaceId, id);
  }
}
