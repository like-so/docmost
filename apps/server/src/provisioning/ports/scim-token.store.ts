export interface NewScimToken {
  name: string;
  tokenHash: string;
  tokenLastFour: string;
  workspaceId: string;
  creatorId: string;
}

export interface ScimTokenRecord {
  id: string;
  name?: string;
  tokenHash?: string;
  tokenLastFour?: string;
  workspaceId?: string;
  isEnabled: boolean;
  createdAt?: Date;
}

export interface ScimTokenStore {
  create(token: NewScimToken): Promise<ScimTokenRecord>;
  findActiveByHash(hash: string): Promise<ScimTokenRecord | undefined>;
  markUsed(id: string): Promise<void>;
  revoke(id: string, workspaceId: string): Promise<void>;
  list(workspaceId: string): Promise<ScimTokenRecord[]>;
}

export const SCIM_TOKEN_STORE = Symbol('SCIM_TOKEN_STORE');
