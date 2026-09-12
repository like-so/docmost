import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { AiIndexService } from './ai-index.service';

@Processor(QueueName.AI_QUEUE)
export class AiProcessor extends WorkerHost {
  constructor(private readonly indexService: AiIndexService) {
    super();
  }
  async process(
    job: Job<{ pageIds?: string[]; spaceId?: string; workspaceId: string }>,
  ): Promise<void> {
    const ids = job.data.pageIds ?? [];
    if (
      [
        QueueJob.PAGE_CREATED,
        QueueJob.PAGE_UPDATED,
        QueueJob.PAGE_RESTORED,
        QueueJob.PAGE_MOVED_TO_SPACE,
      ].includes(job.name as QueueJob)
    )
      await this.indexService.indexPages(ids, job.data.workspaceId);
    if (
      [QueueJob.PAGE_DELETED, QueueJob.PAGE_SOFT_DELETED].includes(
        job.name as QueueJob,
      )
    )
      await this.indexService.removePages(ids, job.data.workspaceId);
    if (
      [
        QueueJob.WORKSPACE_CREATE_EMBEDDINGS,
        QueueJob.WORKSPACE_RESET_EMBEDDINGS,
      ].includes(job.name as QueueJob)
    )
      await this.indexService.reindexWorkspace(job.data.workspaceId);
    if (
      [
        QueueJob.WORKSPACE_DELETE_EMBEDDINGS,
        QueueJob.WORKSPACE_DELETED,
      ].includes(job.name as QueueJob)
    )
      await this.indexService.removeWorkspaceIfSearchDisabled(
        job.data.workspaceId,
      );
    if (job.name === QueueJob.SPACE_DELETED && job.data.spaceId)
      await this.indexService.removeSpace(
        job.data.spaceId,
        job.data.workspaceId,
      );
  }
}
