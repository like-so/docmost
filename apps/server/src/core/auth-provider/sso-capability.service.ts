import { Injectable, NotFoundException } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';

@Injectable()
export class SsoCapabilityService {
  constructor(private readonly environment: EnvironmentService) {}

  assertEnabled(): void {
    if (!this.environment.isSsoCapabilityEnabled()) {
      throw new NotFoundException('SSO capability is disabled.');
    }
  }
}
