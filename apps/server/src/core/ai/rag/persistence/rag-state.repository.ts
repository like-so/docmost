import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import {
  DocumentKey,
  IndexCause,
  IndexOperation,
  InputRevision,
  PublishOutcome,
  RagError,
  toInputRevision,
} from '../contracts';

export type RagSourceStatus = 'live' | 'deleted' | 'hard_deleted';

export interface RagSourceStateRow {
  workspaceId: string;
  pageId: string;
  desiredInputRevision: string;
  sourceStatus: RagSourceStatus;
  lastOperation: IndexOperation | null;
  lastCause: IndexCause | null;
  publishedInputRevision: string | null;
  publishedGenerationId: string | null;
}

export interface RagWorkspaceProfileRow {
  workspaceId: string;
  enabled: boolean;
  profileId: string | null;
  profileHash: string | null;
}

/**
 * Conditional primitives over the per-document RAG source state: revision
 * advance, tombstone transitions and the guarded publication pointer. All
 * mutations are conditional on the current persisted state so a stale worker
 * can never win over a newer revision.
 */
@Injectable()
export class RagStateRepository {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async find(
    db: KyselyDB | KyselyTransaction,
    key: DocumentKey,
  ): Promise<RagSourceStateRow | null> {
    const row = await db
      .selectFrom('ragSourceState')
      .selectAll()
      .where('workspaceId', '=', key.workspaceId)
      .where('pageId', '=', key.pageId)
      .executeTakeFirst();
    return (row as RagSourceStateRow | undefined) ?? null;
  }

  /**
   * Atomically advance desiredInputRevision by one for a source change.
   * A hard-deleted tombstone is never resurrected: the upsert is skipped and
   * the caller's transaction fails. Revision monotonicity holds under
   * concurrent transactions because the increment runs inside the conflict
   * update.
   */
  async advanceForChange(
    trx: KyselyTransaction,
    key: DocumentKey,
    operation: IndexOperation,
    cause: IndexCause,
  ): Promise<{ inputRevision: InputRevision; sourceStatus: RagSourceStatus }> {
    const updated = await trx
      .insertInto('ragSourceState')
      .values({
        workspaceId: key.workspaceId,
        pageId: key.pageId,
        desiredInputRevision: '1',
        sourceStatus: operation === 'delete' ? 'deleted' : 'live',
        lastOperation: operation,
        lastCause: cause,
      })
      .onConflict((oc) =>
        oc
          .columns(['workspaceId', 'pageId'])
          .doUpdateSet({
            desiredInputRevision: sql`rag_source_state.desired_input_revision + 1`,
            sourceStatus: sql`CASE WHEN excluded.last_operation = 'delete' THEN 'deleted' WHEN excluded.last_cause = 'restore' THEN 'live' ELSE rag_source_state.source_status END`,
            lastOperation: sql`excluded.last_operation`,
            lastCause: sql`excluded.last_cause`,
            updatedAt: new Date(),
          })
          .where('ragSourceState.sourceStatus', '!=', 'hard_deleted'),
      )
      .returning(['desiredInputRevision', 'sourceStatus'])
      .executeTakeFirst();

    if (!updated) {
      throw new RagError(
        'INDEX_WRITE_FAILED',
        'RAG source identity was hard-deleted and cannot be recreated',
      );
    }

    return {
      inputRevision: toInputRevision(updated.desiredInputRevision),
      sourceStatus: updated.sourceStatus as RagSourceStatus,
    };
  }

  /**
   * Conditionally transition a source state to its hard-deleted tombstone.
   * The published pointer is cleared; the row itself survives page deletion
   * so late jobs can be rejected. Returns false when already tombstoned.
   */
  async markHardDeleted(
    trx: KyselyTransaction,
    key: DocumentKey,
  ): Promise<boolean> {
    const result = await trx
      .updateTable('ragSourceState')
      .set({
        sourceStatus: 'hard_deleted',
        publishedInputRevision: null,
        publishedGenerationId: null,
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', key.workspaceId)
      .where('pageId', '=', key.pageId)
      .where('sourceStatus', '!=', 'hard_deleted')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Conditionally switch the active generation pointer. The update only wins
   * when the caller's revision still equals desiredInputRevision, the source
   * is live and the persisted current workspace profile is enabled with the
   * same profileHash; otherwise the outcome reports superseded, deleted or
   * disabled. A stale worker may neither publish nor clear a newer pointer.
   */
  async compareAndSwapPublication(
    trx: KyselyTransaction,
    key: DocumentKey,
    expectedInputRevision: InputRevision,
    profileHash: string,
    generationId: string,
  ): Promise<PublishOutcome> {
    const result = await trx
      .updateTable('ragSourceState')
      .set({
        publishedInputRevision: expectedInputRevision,
        publishedGenerationId: generationId,
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', key.workspaceId)
      .where('pageId', '=', key.pageId)
      .where('desiredInputRevision', '=', expectedInputRevision)
      .where('sourceStatus', '=', 'live')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('ragWorkspaceProfile as wp')
            .select('wp.workspaceId')
            .whereRef('wp.workspaceId', '=', 'ragSourceState.workspaceId')
            .where('wp.enabled', '=', true)
            .where('wp.profileHash', '=', profileHash),
        ),
      )
      .executeTakeFirst();

    if (Number(result.numUpdatedRows) > 0) return 'published';

    const state = await this.find(trx, key);
    if (!state || state.sourceStatus !== 'live') return 'deleted';

    const profile = await this.findWorkspaceProfile(trx, key.workspaceId);
    if (!profile || !profile.enabled) return 'disabled';
    return 'superseded';
  }

  async findWorkspaceProfile(
    db: KyselyDB | KyselyTransaction,
    workspaceId: string,
  ): Promise<RagWorkspaceProfileRow | null> {
    const row = await db
      .selectFrom('ragWorkspaceProfile')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return (row as RagWorkspaceProfileRow | undefined) ?? null;
  }

  /** Persist the resolved owner-controlled workspace profile state. */
  async updateWorkspaceProfile(
    trx: KyselyTransaction,
    workspaceId: string,
    profile: {
      enabled: boolean;
      profileId: string | null;
      profileHash: string | null;
    },
  ): Promise<void> {
    await trx
      .insertInto('ragWorkspaceProfile')
      .values({
        workspaceId,
        enabled: profile.enabled,
        profileId: profile.profileId,
        profileHash: profile.profileHash,
      })
      .onConflict((oc) =>
        oc.column('workspaceId').doUpdateSet({
          enabled: profile.enabled,
          profileId: profile.profileId,
          profileHash: profile.profileHash,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }
}
