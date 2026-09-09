import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { EnvironmentService } from '../../integrations/environment/environment.service';

@Injectable()
export class PageVerificationScheduler
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notifications: Queue,
    private readonly schedules: SchedulerRegistry,
    private readonly environment: EnvironmentService,
  ) {}

  onModuleInit() {
    const name = 'page-verification-reconcile';
    if (this.schedules.doesExist('interval', name)) return;
    const interval = setInterval(
      () => void this.enqueueReconciliation(),
      this.environment.getVerificationReconcileIntervalMs(),
    );
    this.schedules.addInterval(name, interval);
    void this.enqueueReconciliation();
  }

  onModuleDestroy() {
    const name = 'page-verification-reconcile';
    if (this.schedules.doesExist('interval', name))
      this.schedules.deleteInterval(name);
  }

  async enqueueReconciliation() {
    await this.notifications.add(
      QueueJob.VERIFICATION_RECONCILE,
      {},
      {
        jobId: 'page-verification-reconcile',
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async reconcile() {
    const due = await this.db
      .selectFrom('pageVerifications')
      .select(['id', 'expiresAt', 'status'])
      .where('type', '=', 'expiring')
      .where('expiresAt', 'is not', null)
      .execute();
    const now = Date.now();
    for (const item of due) {
      const expiresAt = new Date(item.expiresAt!).getTime();
      if (expiresAt <= now && item.status !== 'expired') {
        await this.db
          .updateTable('pageVerifications')
          .set({ status: 'expired', updatedAt: new Date() })
          .where('id', '=', item.id)
          .execute();
        await this.notifications.add(QueueJob.PAGE_VERIFICATION_EXPIRED, {
          verificationId: item.id,
        });
      } else if (
        expiresAt > now &&
        expiresAt - now <= 7 * 24 * 60 * 60 * 1000
      ) {
        await this.notifications.add(
          QueueJob.PAGE_VERIFICATION_EXPIRING,
          { verificationId: item.id },
          { jobId: `verification-expiring-${item.id}` },
        );
      }
    }
  }
}
