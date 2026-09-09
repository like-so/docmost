export interface MfaPolicy {
  requiresChallenge(userId: string, workspaceId: string): Promise<boolean>;
}

export const MFA_POLICY = Symbol('MFA_POLICY');
