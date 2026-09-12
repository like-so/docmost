export interface ExternalGroup {
  externalId: string;
  displayName: string;
  memberExternalIds: string[];
}

export interface GroupSyncStore {
  syncGroup(workspaceId: string, group: ExternalGroup): Promise<void>;
  replaceGroup(
    workspaceId: string,
    groupId: string,
    group: ExternalGroup,
  ): Promise<void>;
  syncUserGroups(
    workspaceId: string,
    userId: string,
    providerId: string,
    groupIds: string[],
  ): Promise<void>;
}

export const GROUP_SYNC_STORE = Symbol('GROUP_SYNC_STORE');
