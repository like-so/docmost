import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { parseIndexRequest, RAG_INDEXER, RagError } from './contracts';
import { RagIndexerService } from './rag-indexer.service';

/**
 * Sole consumer of the dedicated RAG queue, carrying only the identifier-only
 * index requests delivered by the outbox relay. The queue is separate from
 * AI_QUEUE because the legacy AiProcessor completes unknown job names as
 * no-ops, which would nondeterministically drop shared-queue deliveries.
 * Transient failures rethrow so the queue's bounded retry policy applies; when
 * the final attempt fails the durable failed phase is persisted so status is
 * never silently stuck.
 */
@Processor(QueueName.RAG_QUEUE)
export class RagProcessor extends WorkerHost {
  constructor(
    @Inject(RAG_INDEXER) private readonly indexer: RagIndexerService,
  ) {
    super();
  }

  async process(job: Job<string>): Promise<unknown> {
    if (job.name !== QueueJob.RAG_INDEX_REQUEST) return undefined;
    const request = parseIndexRequest(job.data);
    try {
      return await this.indexer.handle(request);
    } catch (error) {
      // attemptsMade is zero-based: within N attempts the final attempt
      // reports N-1, so the durable failed phase must persist there.
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts - 1) {
        await this.indexer.recordFailure(
          request,
          error instanceof RagError ? error.code : 'INDEX_WRITE_FAILED',
        );
      }
      throw error;
    }
  }
}
