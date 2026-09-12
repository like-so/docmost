import { Module } from '@nestjs/common';
import { GROUP_SYNC_STORE } from './ports/group-sync.store';
import { MFA_POLICY } from './ports/mfa-policy';
import { SCIM_TOKEN_STORE } from './ports/scim-token.store';
import { GroupSyncService } from './services/group-sync.service';
import { ScimController } from './scim.controller';
import { ScimAdminController } from './scim-admin.controller';
import { MfaService } from './services/mfa.service';
import { ScimBearerGuard } from './guards/scim-bearer.guard';
import { ScimResourceService } from './services/scim-resource.service';
import { KyselyGroupSyncStore } from './services/group-sync.store';
import { MfaGateService } from './services/mfa-gate.service';
import { DatabaseMfaPolicy } from './services/mfa-policy.store';
import { ScimTokenService } from './services/scim-token.service';
import { KyselyScimTokenStore } from './services/scim-token.store';

@Module({
  controllers: [ScimController, ScimAdminController],
  providers: [
    ScimBearerGuard,
    ScimResourceService,
    MfaService,
    ScimTokenService,
    GroupSyncService,
    MfaGateService,
    KyselyScimTokenStore,
    KyselyGroupSyncStore,
    DatabaseMfaPolicy,
    { provide: SCIM_TOKEN_STORE, useExisting: KyselyScimTokenStore },
    { provide: GROUP_SYNC_STORE, useExisting: KyselyGroupSyncStore },
    { provide: MFA_POLICY, useExisting: DatabaseMfaPolicy },
  ],
  exports: [ScimTokenService, GroupSyncService, MfaGateService, MfaService],
})
export class ProvisioningModule {}
