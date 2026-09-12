import { MfaGateService } from './mfa-gate.service';

describe('MfaGateService', () => {
  it('reports when a login must create an MFA challenge', async () => {
    const service = new MfaGateService({
      requiresChallenge: jest.fn().mockResolvedValue(true),
    });
    await expect(
      service.requiresChallenge('user-id', 'workspace-id'),
    ).resolves.toBe(true);
  });

  it('reports when a login can create a session immediately', async () => {
    const service = new MfaGateService({
      requiresChallenge: jest.fn().mockResolvedValue(false),
    });
    await expect(
      service.requiresChallenge('user-id', 'workspace-id'),
    ).resolves.toBe(false);
  });
});
