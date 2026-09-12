import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationProcessor } from './notification.processor';
import { CommentNotificationService } from './services/comment.notification';
import { PageNotificationService } from './services/page.notification';
import { VerificationNotificationService } from './services/verification.notification';
import { PageUpdateEmailRateLimiter } from './services/page-update-email-rate-limiter';
import { PageVerificationModule } from '../page-verification/page-verification.module';

@Module({
  imports: [PageVerificationModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationProcessor,
    CommentNotificationService,
    PageNotificationService,
    VerificationNotificationService,
    PageUpdateEmailRateLimiter,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
