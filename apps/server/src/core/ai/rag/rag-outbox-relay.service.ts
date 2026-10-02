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
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
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
/** Treat staged work at the current profile as abandoned after this window. */
const STAGED_GRACE_WINDOW_MS = 15 * 60 * 1000;

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
 * profile changes survive restarts without in-memory assumptions. Delivered
 * outbox rows are purged once they leave the recent-delivery dedup window.
 * Live pages in enabled workspaces whose published state is not at the current
 * profile, or whose desired revision has no live path to completion, are
 * re-requested with a profile cause. Scheduling carries a durable
 * per-target-profile dedup evaluated under the source-state row lock, so
 * repeated or concurrent sweeps record at most one event per page per profile
 * generation:
 * - a pending delivery resolves the current profile when it runs;
 * - a recently delivered job may still be running while the desired revision
 *   has no live publication (slow publication is not superseded by later
 *   sweeps); once the desired revision is published the delivery is complete
 *   and profile drift alone warrants a new event;
 * - staged work at the current profile created after the profile row last
 *   changed is active within the grace window, and abandoned afterwards;
 * - a durable failed phase at the current profile stays terminal until the
 *   next settings save, which advances the profile row's updated_at and
 *   releases both staged and failed work for recovery.
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
      await this.purgeExpiredDeliveries();
      await this.deliverPending();
      await this.reconcileStalledPages();
    } finally {
      this.reconciling = false;
    }
  }

  private reconciling = false;

  /**
   * Delivered outbox rows exist only for the recent-delivery dedup window;
   * once a delivery leaves that window it no longer suppresses recovery and
   * the row is garbage. Purging keeps the outbox bounded.
   */
  private async purgeExpiredDeliveries(): Promise<void> {
    try {
      await this.db
        .deleteFrom('ragOutbox')
        .where('status', '=', 'delivered')
        .where(
          'deliveredAt',
          '<',
          new Date(Date.now() - RECENT_DELIVERY_WINDOW_MS),
        )
        .execute();
    } catch (error) {
      this.logger.warn(
        `rag-relay delivered purge failed: ${describeError(error)}`,
      );
    }
  }

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
    const cutoffs = {
      recentDelivery: new Date(Date.now() - RECENT_DELIVERY_WINDOW_MS),
      stagedGrace: new Date(Date.now() - STAGED_GRACE_WINDOW_MS),
    };
    let candidates;
    try {
      candidates = await this.selectReindexCandidates(this.db, cutoffs)
        .limit(RECONCILE_PAGE_BATCH)
        .execute();
    } catch (error) {
      this.logger.warn(`rag-relay stall scan failed: ${describeError(error)}`);
      return;
    }
    for (const candidate of candidates) {
      await this.recordProfileReindex(
        candidate.workspaceId,
        candidate.pageId,
        cutoffs,
      );
    }
  }

  /**
   * Live pages in enabled workspaces whose published state is not at the
   * current profile, or whose desired revision has no live path to
   * completion. The NOT EXISTS clauses are the durable per-target-profile
   * dedup: pending or recent deliveries, staged work at the current profile
   * within its grace window, and durable failed phases at the current
   * profile created after the profile row last changed all suppress a new
   * event. Obsolete staged/failed work (older profile hash or older profile
   * row) and expired grace windows release the page for recovery.
   */
  private selectReindexCandidates(
    db: KyselyDB | KyselyTransaction,
    cutoffs: { recentDelivery: Date; stagedGrace: Date },
  ) {
    return db
      .selectFrom('ragSourceState as s')
      .innerJoin('ragWorkspaceProfile as wp', 'wp.workspaceId', 's.workspaceId')
      .leftJoin('ragGenerations as pub', 'pub.id', 's.publishedGenerationId')
      .select(['s.workspaceId', 's.pageId'])
      .where('wp.enabled', '=', true)
      .where('s.sourceStatus', '=', 'live').where(sql<boolean>`(
        s.published_input_revision is null
        or pub.profile_hash is distinct from wp.profile_hash
        or s.desired_input_revision > s.published_input_revision
      )`).where(sql<boolean>`not exists (
        select 1 from rag_outbox o
        where o.workspace_id = s.workspace_id
          and o.page_id = s.page_id
          and (
            o.status = 'pending'
            or (
              o.delivered_at > ${cutoffs.recentDelivery}
              and (s.published_input_revision is null
                or s.desired_input_revision > s.published_input_revision)
            )
          )
      )`).where(sql<boolean>`not exists (
        select 1 from rag_generations g
        where g.workspace_id = s.workspace_id
          and g.page_id = s.page_id
          and g.input_revision = s.desired_input_revision
          and g.profile_hash = wp.profile_hash
          and g.created_at >= wp.updated_at
          and (
            (g.status = 'staged' and g.created_at > ${cutoffs.stagedGrace})
            or g.status = 'failed'
          )
      )`);
  }

  private async recordProfileReindex(
    workspaceId: string,
    pageId: string,
    cutoffs: { recentDelivery: Date; stagedGrace: Date },
  ): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        // Serialize concurrent sweeps per page, then re-check the dedup on a
        // fresh read so only one recorder wins per profile generation.
        const locked = await trx
          .selectFrom('ragSourceState')
          .select('pageId')
          .where('workspaceId', '=', workspaceId)
          .where('pageId', '=', pageId)
          .where('sourceStatus', '=', 'live')
          .forUpdate()
          .executeTakeFirst();
        if (!locked) return;
        const eligible = await this.selectReindexCandidates(trx, cutoffs)
          .where('s.pageId', '=', pageId)
          .limit(1)
          .execute();
        if (eligible.length === 0) return;
        await this.sourceLedger.recordChange(
          trx,
          { workspaceId, pageId },
          'upsert',
          'profile',
        );
      });
    } catch (error) {
      // A hard-deleted identity rejects the transaction; the next sweep
      // re-derives the remaining candidates from persisted state.
      this.logger.warn(
        `rag-relay profile reindex scheduling failed workspaceId=${workspaceId} pageId=${pageId}: ${describeError(error)}`,
      );
    }
  }
}

/** Redacted: persistent identity codes only, never error payload text. */
function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}
