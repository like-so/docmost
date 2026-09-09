import { Module } from '@nestjs/common';
import { AuthProviderController } from './auth-provider.controller';
import { AuthProviderService } from './auth-provider.service';
import { SsoCapabilityService } from './sso-capability.service';
import { SsoController } from './sso.controller';
import { OidcService } from './oidc.service';
import { AuthModule } from '../auth/auth.module';
import { LdapService } from './ldap.service';
import { SamlService } from './saml.service';
import { EncryptionModule } from '../../integrations/encryption/encryption.module';
import { OutboundModule } from '../../integrations/outbound/outbound.module';

@Module({
  imports: [AuthModule, EncryptionModule, OutboundModule],
  controllers: [AuthProviderController, SsoController],
  providers: [
    AuthProviderService,
    SsoCapabilityService,
    OidcService,
    LdapService,
    SamlService,
  ],
  exports: [AuthProviderService],
})
export class AuthProviderModule {}
