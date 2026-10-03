import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Injectable } from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { RagActor, RagEvidence, toInputRevision } from '../contracts';

/**
 * Centralized post-async evidence gate (docmost-rag-v1 contract 12). Every
 * evidence item must still resolve, at validation time, to a chunk of the
 * exact generation the source-state publication pointer names, published
 * under the currently enabled workspace profile, on a live, nondeleted source
 * whose published revision still equals the desired revision; the item's own
 * input revision must still equal the generation's. Current Docmost
 * authorization (space membership plus the authoritative page-level
 * restriction check) is rechecked for the actor in the same pass.
 *
 * The rerank stage is asynchronous, and so is a provider model call: callers
 * run this gate after such stages and immediately before output or model use
 * (retriever exit, search response, chat pre-model and post-generation). A
 * chunk dropped by the gate must never surface, persist, or reach the model.
 * Survivors preserve their input order; nothing is re-scored or re-ordered.
 */
@Injectable()
export class RagEvidenceGate {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async validate(
    actor: RagActor,
    evidence: RagEvidence[],
  ): Promise<RagEvidence[]> {
    if (evidence.length === 0) return [];
    const scoped = evidence.filter(
      (item) => item.key.workspaceId === actor.workspaceId,
    );
    if (scoped.length === 0) return [];

    const chunkIds = [...new Set(scoped.map((item) => item.chunkId))];
    const rows = await this.db
      .selectFrom('ragChunks as rc')
      .innerJoin('ragSourceState as rss', (join) =>
        join.on((eb) =>
          eb.and([
            eb('rss.workspaceId', '=', eb.ref('rc.workspaceId')),
            eb('rss.pageId', '=', eb.ref('rc.pageId')),
          ]),
        ),
      )
      .innerJoin('ragGenerations as rg', (join) =>
        join.onRef('rg.id', '=', 'rss.publishedGenerationId'),
      )
      .innerJoin(
        'ragWorkspaceProfile as rwp',
        'rwp.workspaceId',
        'rss.workspaceId',
      )
      .innerJoin('pages as p', 'p.id', 'rc.pageId')
      .where('rc.id', 'in', chunkIds)
      .where('rc.workspaceId', '=', actor.workspaceId)
      .where('p.workspaceId', '=', actor.workspaceId)
      .where('rwp.enabled', '=', true)
      .whereRef('rg.profileHash', '=', 'rwp.profileHash')
      .where('rg.status', '=', 'published')
      // The chunk must belong to the exact currently published generation, so
      // a replaced generation cannot ride on an unchanged input revision.
      .whereRef('rc.generationId', '=', 'rss.publishedGenerationId')
      .where('rss.sourceStatus', '=', 'live')
      .where('p.deletedAt', 'is', null)
      .whereRef('rss.publishedInputRevision', '=', 'rss.desiredInputRevision')
      .select([
        'rc.id as chunkId',
        'rg.inputRevision as inputRevision',
        'p.spaceId as spaceId',
      ])
      .execute();

    const fresh = new Map<string, { inputRevision: string; spaceId: string }>();
    for (const row of rows as unknown as Array<{
      chunkId: string;
      inputRevision: string;
      spaceId: string;
    }>) {
      fresh.set(row.chunkId, {
        // int8 arrives as a number under the driver's bigint parse config;
        // compare against the decimal-string contract, not the raw value.
        inputRevision: toInputRevision(row.inputRevision),
        spaceId: row.spaceId,
      });
    }
    const freshEvidence = scoped.filter((item) => {
      const state = fresh.get(item.chunkId);
      return state !== undefined && state.inputRevision === item.inputRevision;
    });
    if (freshEvidence.length === 0) return [];

    // The same authorization recheck the retriever boundary applies, now as
    // the final gate for every consumer (search, chat recall and citations).
    const spaceIds = new Set(
      await this.spaceMemberRepo.getUserSpaceIds(actor.userId),
    );
    const inSpace = freshEvidence.filter((item) =>
      spaceIds.has(fresh.get(item.chunkId)!.spaceId),
    );
    if (inSpace.length === 0) return [];
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: [...new Set(inSpace.map((item) => item.key.pageId))],
        userId: actor.userId,
      }),
    );
    return inSpace.filter((item) => accessible.has(item.key.pageId));
  }
}
