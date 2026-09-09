import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE } from './audit.service';
import { DurableAuditService } from './durable-audit.service';
import { AuditController } from './audit.controller';

@Global()
@Module({
  controllers: [AuditController],
  providers: [
    {
      provide: AUDIT_SERVICE,
      useClass: DurableAuditService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
