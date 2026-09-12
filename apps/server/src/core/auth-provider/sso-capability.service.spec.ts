import { NotFoundException } from '@nestjs/common';
import { SsoCapabilityService } from './sso-capability.service';

describe('SsoCapabilityService', () => {
  it('uses the deployment capability switch without license validation', () => {
    const service = new SsoCapabilityService({
      isSsoCapabilityEnabled: jest.fn().mockReturnValue(true),
    } as any);
    expect(() => service.assertEnabled()).not.toThrow();
  });

  it('does not expose SSO routes when the capability switch is disabled', () => {
    const service = new SsoCapabilityService({
      isSsoCapabilityEnabled: jest.fn().mockReturnValue(false),
    } as any);
    expect(() => service.assertEnabled()).toThrow(NotFoundException);
  });
});
