import { Module } from '@nestjs/common';
import { PageModule } from '../page/page.module';
import { PageVerificationController } from './page-verification.controller';
import { PageVerificationScheduler } from './page-verification.scheduler';
import { PageVerificationService } from './page-verification.service';
@Module({
  imports: [PageModule],
  controllers: [PageVerificationController],
  providers: [PageVerificationService, PageVerificationScheduler],
  exports: [PageVerificationScheduler],
})
export class PageVerificationModule {}
