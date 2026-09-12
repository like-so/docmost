import { Inject, Injectable } from '@nestjs/common';
import { MFA_POLICY, MfaPolicy } from '../ports/mfa-policy';

@Injectable()
export class MfaGateService {
  constructor(@Inject(MFA_POLICY) private readonly policy: MfaPolicy) {}

  async requiresChallenge(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    return this.policy.requiresChallenge(userId, workspaceId);
  }
}
