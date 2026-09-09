import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { DocumentExportService } from './document-export.service';
import { ExportController } from './export.controller';
import { StorageModule } from '../storage/storage.module';
import { OutboundModule } from '../outbound/outbound.module';

@Module({
  imports: [StorageModule, OutboundModule],
  providers: [ExportService, DocumentExportService],
  controllers: [ExportController],
})
export class ExportModule {}
