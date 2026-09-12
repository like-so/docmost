import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { BaseService } from '../core/base/base.service';

@Injectable()
export class BaseRealtimeBridge {
  private server: Server;

  constructor(
    private readonly users: UserRepo,
    private readonly bases: BaseService,
    private readonly permissions: PagePermissionRepo,
    private readonly spaceMembers: SpaceMemberRepo,
  ) {}

  setServer(server: Server): void { this.server = server; }

  isBaseEvent(data: unknown): data is { type: 'base:changed'; pageId: string; version: number } {
    if (!data || typeof data !== 'object') return false;
    const event = data as Record<string, unknown>;
    return event.type === 'base:changed' && typeof event.pageId === 'string' && Number.isInteger(event.version);
  }

  async handleInbound(client: Socket, data: { type: 'base:changed'; pageId: string; version: number }): Promise<void> {
    const user = await this.users.findById(client.data.userId, client.data.workspaceId);
    if (!user) return;
    const base = await this.bases.get(data.pageId, user);
    if (!base.permissions.canEdit || data.version > base.page.baseSchemaVersion) return;
    await this.broadcast(base.page.id, base.page.spaceId, base.page.workspaceId, base.page.baseSchemaVersion);
  }

  async handleDisconnect(_client: Socket): Promise<void> {}

  private async broadcast(pageId: string, spaceId: string, workspaceId: string, version: number): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.in(`workspace-${workspaceId}`).fetchSockets();
    const userIds = [...new Set(sockets.map((socket) => socket.data.userId).filter((id): id is string => typeof id === 'string'))];
    if (!userIds.length) return;
    const spaceMemberIds = await this.spaceMembers.getUserIdsWithSpaceAccess(userIds, spaceId);
    const authorized = new Set(await this.permissions.getUserIdsWithPageAccess(pageId, [...spaceMemberIds]));
    for (const socket of sockets) {
      if (authorized.has(socket.data.userId)) {
        socket.emit('base:changed', { pageId, version });
      }
    }
  }
}
