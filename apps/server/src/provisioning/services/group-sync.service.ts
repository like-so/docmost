import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  ExternalGroup,
  GROUP_SYNC_STORE,
  GroupSyncStore,
} from '../ports/group-sync.store';

@Injectable()
export class GroupSyncService {
  constructor(
    @Inject(GROUP_SYNC_STORE) private readonly store: GroupSyncStore,
  ) {}

  async syncUserGroups(
    workspaceId: string,
    userId: string,
    providerId: string,
    groupIds: string[],
  ): Promise<void> {
    await this.store.syncUserGroups(workspaceId, userId, providerId, [
      ...new Set(
        groupIds
          .map((group) => group.trim().toLocaleLowerCase())
          .filter(Boolean),
      ),
    ]);
  }

  async sync(workspaceId: string, group: ExternalGroup): Promise<void> {
    await this.validateGroup(group);
    await this.store.syncGroup(workspaceId, this.uniqueMembers(group));
  }

  async replace(
    workspaceId: string,
    groupId: string,
    group: ExternalGroup,
  ): Promise<void> {
    await this.validateGroup(group);
    await this.store.replaceGroup(
      workspaceId,
      groupId,
      this.uniqueMembers(group),
    );
  }

  private async validateGroup(group: ExternalGroup): Promise<void> {
    if (!group.externalId || !group.displayName) {
      throw new BadRequestException(
        'SCIM groups require externalId and displayName',
      );
    }
  }

  private uniqueMembers(group: ExternalGroup): ExternalGroup {
    return {
      ...group,
      memberExternalIds: [...new Set(group.memberExternalIds)],
    };
  }
}
