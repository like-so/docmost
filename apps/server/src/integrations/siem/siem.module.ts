import { Module } from '@nestjs/common';
import { SiemDestinationRepo } from '../../database/repos/siem/siem-destination.repo';
import { SiemOutboxRepo } from '../../database/repos/siem/siem-outbox.repo';
import { SiemService } from './siem.service';
import { SiemController } from './siem.controller';
import { SiemDeliveryService } from './siem-delivery.service';
import { SiemDispatcherService } from './siem-dispatcher.service';
import { SiemProcessor } from './siem.processor';

@Module({
  controllers: [SiemController],
  providers: [
    SiemDestinationRepo,
    SiemOutboxRepo,
    SiemService,
    SiemDeliveryService,
    SiemDispatcherService,
    SiemProcessor,
  ],
  exports: [SiemService],
})
export class SiemModule {}
