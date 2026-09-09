import { Test } from '@nestjs/testing';

jest.mock('./oidc.service', () => ({
  OidcService: class OidcService {},
}));
jest.mock('./saml.service', () => ({
  SamlService: class SamlService {},
}));
jest.mock('./auth-provider.controller', () => ({
  AuthProviderController: class AuthProviderController {},
}));
jest.mock('./sso.controller', () => ({
  SsoController: class SsoController {},
}));
jest.mock('../workspace/workspace.module', () => ({
  WorkspaceModule: class WorkspaceModule {},
}));
jest.mock('../../provisioning/provisioning.module', () => ({
  ProvisioningModule: class ProvisioningModule {},
}));
jest.mock('../auth/auth.controller', () => ({
  AuthController: class AuthController {},
}));
jest.mock('../../provisioning/mfa.controller', () => ({
  MfaController: class MfaController {},
}));
jest.mock('../auth/strategies/jwt.strategy', () => ({
  JwtStrategy: class JwtStrategy {},
}));

process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.APP_SECRET = 'test-secret-that-is-at-least-thirty-two-characters';

import { AuthService } from '../auth/services/auth.service';
import { AuthModule } from '../auth/auth.module';
import { SignupService } from '../auth/services/signup.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { EnvironmentModule } from '../../integrations/environment/environment.module';
import { AuthProviderModule } from './auth-provider.module';
import { AuthProviderService } from './auth-provider.service';
import { LdapService } from './ldap.service';
import { SamlService } from './saml.service';
import { OidcService } from './oidc.service';
import { SsoCapabilityService } from './sso-capability.service';

describe('AuthProviderModule', () => {
  it('compiles with the AuthService exported by AuthModule', async () => {
    const module = await Test.createTestingModule({
      imports: [EnvironmentModule, AuthProviderModule],
    })
      .overrideProvider(AuthService)
      .useValue({})
      .overrideProvider(SignupService)
      .useValue({})
      .overrideProvider(JwtStrategy)
      .useValue({})
      .overrideProvider(AuthProviderService)
      .useValue({})
      .overrideProvider(SsoCapabilityService)
      .useValue({})
      .overrideProvider(OidcService)
      .useValue({})
      .overrideProvider(LdapService)
      .useValue({})
      .overrideProvider(SamlService)
      .useValue({})
      .compile();

    expect(module).toBeDefined();
    expect(Reflect.getMetadata('exports', AuthModule)).toContain(AuthService);
  });
});
