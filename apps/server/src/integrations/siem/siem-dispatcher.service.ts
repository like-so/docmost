import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { SiemDestinationRepo } from '../../database/repos/siem/siem-destination.repo';
import { QueueJob, QueueName } from '../queue/constants';
import { SiemOutboxRepo } from '../../database/repos/siem/siem-outbox.repo';
import { EnvironmentService } from '../environment/environment.service';

type AuditAppended = { id: string; workspaceId: string };

@Injectable()
export class SiemDispatcherService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly destinations: SiemDestinationRepo,
    private readonly outbox: SiemOutboxRepo,
    @InjectQueue(QueueName.SIEM_QUEUE) private readonly queue: Queue,
    private readonly schedules: SchedulerRegistry,
    private readonly environment: EnvironmentService,
  ) {}

  onModuleInit() {
    const name = 'siem-reconcile';
    if (this.schedules.doesExist('interval', name)) return;
    this.schedules.addInterval(
      name,
      setInterval(
        () => void this.reconcile(),
        this.environment.getSiemReconcileIntervalMs(),
      ),
    );
    void this.reconcile();
  }

  onModuleDestroy() {
    const name = 'siem-reconcile';
    if (this.schedules.doesExist('interval', name))
      this.schedules.deleteInterval(name);
  }

  @OnEvent('audit.appended')
  async dispatch(event: AuditAppended): Promise<void> {
    const destinations = await this.destinations.list(event.workspaceId);
    await Promise.all(
      destinations
        .filter((destination) => destination.enabled)
        .map((destination) => this.enqueueNext(destination)),
    );
  }

  async reconcile(): Promise<void> {
    const destinations = await this.destinations.listEnabled();
    for (const destination of destinations)
      await this.enqueueNext(destination);
  }

  async enqueueNextById(destinationId: string): Promise<void> {
    const destination = await this.destinations.findById(destinationId);
    if (destination?.enabled) await this.enqueueNext(destination);
  }

  private async enqueueNext(destination: {
    id: string;
    workspaceId: string;
    cursorCreatedAt?: Date | null;
    cursorId?: string | null;
  }): Promise<void> {
    const event = await this.outbox.next(destination.id);
    if (event) await this.enqueue(destination.id, event.auditId);
  }

  private enqueue(destinationId: string, auditId: string): Promise<unknown> {
    return this.queue.add(
      QueueJob.SIEM_DELIVER,
      { destinationId, auditId },
      { jobId: `${destinationId}-${auditId}` },
    );
  }

}
