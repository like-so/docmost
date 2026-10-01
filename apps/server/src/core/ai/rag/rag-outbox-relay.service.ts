import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { IndexRequest, serializeIndexRequest } from './contracts';
import { RagOutboxRepository } from './persistence/rag-outbox.repository';
import { RagSourceLedger } from './persistence/rag-source-ledger';

/**
 * Bounded retry policy for RAG index jobs, applied per job for contract
 * visibility; the queue registration carries the same defaults. Backoff
 * mirrors the exponential pattern used by the other durable queues.
 */
const RAG_JOB_ATTEMPTS = 3;
const RAG_JOB_BACKOFF_DELAY_MS = 20 * 1000;
const OUTBOX_DELIVERY_BATCH = 50;
const RECONCILE_PAGE_BATCH = 200;
const RECONCILE_INTERVAL_MS = 1000;
/** Skip stalled-page rescheduling while a recently delivered job may still run. */
const RECENT_DELIVERY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Durable outbox relay (docmost-rag-v1 contracts 3 and 4). Committed ledger
 * events are enqueued identifiers-only with the eventId as the queue job ID;
 * acknowledgement happens only after an accepted enqueue, so an uncertain
 * result leaves the record pending for the next sweep. At-least-once is safe
 * because consumers are idempotent and the jobId deduplicates concurrent
 * deliveries of the same event. Deliveries go to the dedicated RAG queue
 * (registered alongside the existing queues) whose only consumer is the RAG
 * worker.
 *
 * The reconcile sweep is persisted-state-driven, so disable/re-enable and
 * profile changes survive restarts without in-memory assumptions:
 * - live pages whose desired revision has no queued, staged or failed work
 *   and no recent delivery are re-requested with a profile cause (covers
 *   events consumed while disabled and deliveries lost to a crash);
 * - enabled workspaces whose published generation no longer matches the
 *   current profile hash schedule a paginated profile reindex of all live
 *   pages (contract 8; mismatched retrieval is already excluded by the
 *   retrieval component).
 */
@Injectable()
export class RagOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagOutboxRelayService.name);

  constructor(
    private readonly outboxRepository: RagOutboxRepository,
    private readonly sourceLedger: RagSourceLedger,
    @InjectQueue(QueueName.RAG_QUEUE) private readonly queue: Queue,
    private readonly schedules: SchedulerRegistry,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  onModuleInit() {
    const name = 'rag-outbox-reconcile';
    if (this.schedules.doesExist('interval', name)) return;
    this.schedules.addInterval(
      name,
      setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS),
    );
    void this.reconcile();
  }

  onModuleDestroy() {
    const name = 'rag-outbox-reconcile';
    if (this.schedules.doesExist('interval', name))
      this.schedules.deleteInterval(name);
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.deliverPending();
      await this.reconcileStalledPages();
      await this.reconcileProfileChanges();
    } finally {
      this.reconciling = false;
    }
  }

  private reconciling = false;

  private async deliverPending(): Promise<void> {
    let requests: IndexRequest[];
    try {
      requests = await this.outboxRepository.pending(
        this.db,
        OUTBOX_DELIVERY_BATCH,
      );
    } catch (error) {
      this.logger.warn(
        `rag-relay pending read failed: ${describeError(error)}`,
      );
      return;
    }
    for (const request of requests) {
      try {
        await this.queue.add(
          QueueJob.RAG_INDEX_REQUEST,
          serializeIndexRequest(request),
          {
            jobId: request.eventId,
            attempts: RAG_JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: RAG_JOB_BACKOFF_DELAY_MS },
          },
        );
        await this.outboxRepository.markDelivered(this.db, request.eventId);
      } catch (error) {
        // Uncertain enqueue results stay pending and retry on a later sweep.
        await this.outboxRepository
          .markDeliveryFailed(this.db, request.eventId, 'ENQUEUE_FAILED')
          .catch(() => undefined);
        this.logger.warn(
          `rag-relay enqueue failed eventId=${request.eventId}: ${describeError(error)}`,
        );
      }
    }
  }

  private async reconcileStalledPages(): Promise<void> {
    const recentDeliveryCutoff = new Date(
      Date.now() - RECENT_DELIVERY_WINDOW_MS,
    );
    let candidates;
    try {
      candidates = await this.db
        .selectFrom('ragSourceState as s')
        .select(['s.workspaceId', 's.pageId'])
        .innerJoin(
          'ragWorkspaceProfile as wp',
          'wp.workspaceId',
          's.workspaceId',
        )
        .where('wp.enabled', '=', true)
        .where('s.sourceStatus', '=', 'live')
        .where(
          sql<boolean>`s.published_input_revision is null or s.desired_input_revision > s.published_input_revision`,
        )
        .where(
          sql<boolean>`not exists (
            select 1 from rag_outbox o
            where o.workspace_id = s.workspace_id
              and o.page_id = s.page_id
              and (o.status = 'pending' or o.delivered_at > ${recentDeliveryCutoff})
          )`,
        )
        .where(
          sql<boolean>`not exists (
            select 1 from rag_generations g
            where g.workspace_id = s.workspace_id
              and g.page_id = s.page_id
              and g.input_revision = s.desired_input_revision
              and g.status in ('staged', 'failed')
          )`,
        )
        .limit(RECONCILE_PAGE_BATCH)
        .execute();
    } catch (error) {
      this.logger.warn(`rag-relay stall scan failed: ${describeError(error)}`);
      return;
    }
    for (const candidate of candidates) {
      await this.recordProfileReindex(candidate.workspaceId, [
        candidate.pageId,
      ]);
    }
  }

  private async reconcileProfileChanges(): Promise<void> {
    let workspaces;
    try {
      workspaces = await this.db
        .selectFrom('ragSourceState as s')
        .select('s.workspaceId')
        .distinct()
        .innerJoin(
          'ragWorkspaceProfile as wp',
          'wp.workspaceId',
          's.workspaceId',
        )
        .innerJoin('ragGenerations as g', 'g.id', 's.publishedGenerationId')
        .where('s.sourceStatus', '=', 'live')
        .where('wp.enabled', '=', true)
        .where(sql<boolean>`g.profile_hash != wp.profile_hash`)
        .limit(RECONCILE_PAGE_BATCH)
        .execute();
    } catch (error) {
      this.logger.warn(
        `rag-relay profile scan failed: ${describeError(error)}`,
      );
      return;
    }
    for (const row of workspaces) {
      await this.schedulePaginatedReindex(row.workspaceId);
    }
  }

  private async schedulePaginatedReindex(workspaceId: string): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      let query = this.db
        .selectFrom('ragSourceState')
        .select('pageId')
        .where('workspaceId', '=', workspaceId)
        .where('sourceStatus', '=', 'live')
        .orderBy('pageId', 'asc')
        .limit(RECONCILE_PAGE_BATCH);
      if (cursor) query = query.where('pageId', '>', cursor);
      const pages = await query.execute();
      if (pages.length === 0) break;
      await this.recordProfileReindex(
        workspaceId,
        pages.map((page) => page.pageId),
      );
      if (pages.length < RECONCILE_PAGE_BATCH) break;
      cursor = pages[pages.length - 1].pageId;
    }
  }

  private async recordProfileReindex(
    workspaceId: string,
    pageIds: string[],
  ): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        for (const pageId of pageIds) {
          await this.sourceLedger.recordChange(
            trx,
            { workspaceId, pageId },
            'upsert',
            'profile',
          );
        }
      });
    } catch (error) {
      // A hard-deleted identity rejects the whole batch transaction; the next
      // sweep re-derives the remaining candidates from persisted state.
      this.logger.warn(
        `rag-relay profile reindex scheduling failed workspaceId=${workspaceId}: ${describeError(error)}`,
      );
    }
  }
}

/** Redacted: persistent identity codes only, never error payload text. */
function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}
