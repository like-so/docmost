import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../queue/constants';
import { SiemDeliveryService } from './siem-delivery.service';
import { SiemService } from './siem.service';
import { SiemDispatcherService } from './siem-dispatcher.service';

@Processor(QueueName.SIEM_QUEUE)
export class SiemProcessor extends WorkerHost {
  constructor(
    private readonly delivery: SiemDeliveryService,
    private readonly siemService: SiemService,
    private readonly dispatcher: SiemDispatcherService,
  ) {
    super();
  }

  async process(
    job: Job<{ destinationId: string; auditId: string }>,
  ): Promise<void> {
    if (job.name !== QueueJob.SIEM_DELIVER) return;
    try {
      const delivered = await this.delivery.deliver(
        job.data.destinationId,
        job.data.auditId,
      );
      if (delivered)
        await this.dispatcher.enqueueNextById(job.data.destinationId);
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await this.siemService.recordFailure(
          job.data.destinationId,
          error instanceof Error ? error.message : 'SIEM delivery failed',
        );
      }
      throw error;
    }
  }
}
