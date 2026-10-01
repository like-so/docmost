import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User, Workspace } from '@docmost/db/types/entity.types';
import { RagErrorCode, RagStatusResponse, toInputRevision } from '../contracts';
import { PageAccessService } from '../../../page/page-access/page-access.service';
import {
  RagSourceStateRow,
  RagStateRepository,
} from '../persistence/rag-state.repository';

/**
 * The foundation state row omits the audit timestamps that selectAll()
 * returns; read the persisted updatedAt without widening the shared
 * repository contract.
 */
function stateUpdatedAt(state: RagSourceStateRow | null | undefined): string {
  const withTimestamps = state as
    | (RagSourceStateRow & { updatedAt: Date })
    | null
    | undefined;
  return (withTimestamps?.updatedAt ?? new Date()).toISOString();
}

/**
 * Per-page indexing status adapter (docmost-rag-v1 contract 13). Requires
 * current view permission; deleted pages and pages outside the active
 * workspace reveal no state. The phase is derived from the persisted state
 * machine only: publication pointer, source status, generation outcomes and
 * outbox delivery are the evidence; no liveness guess is reported.
 */
@Injectable()
export class RagStatusService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly stateRepository: RagStateRepository,
    private readonly pageAccessService: PageAccessService,
  ) {}

  async getStatus(
    user: User,
    workspace: Workspace,
    pageId: string,
  ): Promise<RagStatusResponse> {
    const page = await this.loadViewablePage(user, workspace, pageId);
    const key = { workspaceId: workspace.id, pageId: page.id };

    const profileRow = await this.stateRepository.findWorkspaceProfile(
      this.db,
      workspace.id,
    );
    const state = await this.stateRepository.find(this.db, key);
    const desiredInputRevision = toInputRevision(
      state?.desiredInputRevision ?? 0,
    );

    if (!profileRow?.enabled) {
      return {
        pageId: page.id,
        desiredInputRevision,
        publishedInputRevision: state?.publishedInputRevision
          ? toInputRevision(state.publishedInputRevision)
          : null,
        phase: 'disabled',
        updatedAt: stateUpdatedAt(state),
      };
    }

    if (!state) {
      return {
        pageId: page.id,
        desiredInputRevision,
        publishedInputRevision: null,
        phase: 'pending',
        updatedAt: new Date().toISOString(),
      };
    }

    if (state.sourceStatus !== 'live') {
      return {
        pageId: page.id,
        desiredInputRevision,
        publishedInputRevision: state.publishedInputRevision
          ? toInputRevision(state.publishedInputRevision)
          : null,
        phase: 'deleted',
        updatedAt: stateUpdatedAt(state),
      };
    }

    const publishedGeneration = state.publishedGenerationId
      ? await this.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('id', '=', state.publishedGenerationId)
          .executeTakeFirst()
      : undefined;
    if (
      publishedGeneration?.status === 'published' &&
      state.publishedInputRevision === state.desiredInputRevision
    ) {
      return {
        pageId: page.id,
        desiredInputRevision,
        publishedInputRevision: toInputRevision(state.publishedInputRevision),
        phase: 'ready',
        generationId: publishedGeneration.id,
        updatedAt: stateUpdatedAt(state),
      };
    }

    const failedGeneration = await this.db
      .selectFrom('ragGenerations')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('pageId', '=', page.id)
      .where('status', '=', 'failed')
      .where('inputRevision', '=', state.desiredInputRevision)
      .orderBy('updatedAt', 'desc')
      .executeTakeFirst();
    if (failedGeneration) {
      return {
        pageId: page.id,
        desiredInputRevision,
        publishedInputRevision: state.publishedInputRevision
          ? toInputRevision(state.publishedInputRevision)
          : null,
        phase: 'failed',
        errorCode: failedGeneration.errorCode as RagErrorCode,
        updatedAt: failedGeneration.updatedAt.toISOString(),
      };
    }

    const stagedGeneration = await this.db
      .selectFrom('ragGenerations')
      .select('id')
      .where('workspaceId', '=', workspace.id)
      .where('pageId', '=', page.id)
      .where('status', '=', 'staged')
      .where('inputRevision', '=', state.desiredInputRevision)
      .executeTakeFirst();
    if (stagedGeneration) {
      return {
        pageId: page.id,
        desiredInputRevision,
        publishedInputRevision: state.publishedInputRevision
          ? toInputRevision(state.publishedInputRevision)
          : null,
        phase: 'processing',
        updatedAt: stateUpdatedAt(state),
      };
    }

    const outboxRow = await this.db
      .selectFrom('ragOutbox')
      .select(['status', 'createdAt'])
      .where('workspaceId', '=', workspace.id)
      .where('pageId', '=', page.id)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const phase =
      outboxRow && outboxRow.status !== 'pending' ? 'processing' : 'pending';

    return {
      pageId: page.id,
      desiredInputRevision,
      publishedInputRevision: state.publishedInputRevision
        ? toInputRevision(state.publishedInputRevision)
        : null,
      phase,
      updatedAt: stateUpdatedAt(state),
    };
  }

  private async loadViewablePage(
    user: User,
    workspace: Workspace,
    pageId: string,
  ): Promise<Page> {
    const row = await this.db
      .selectFrom('pages')
      .select(['id', 'workspaceId', 'spaceId', 'deletedAt'])
      .where('id', '=', pageId)
      .executeTakeFirst();
    if (!row || row.workspaceId !== workspace.id || row.deletedAt) {
      // A foreign or deleted page reveals no state at all.
      throw new NotFoundException();
    }
    const page = row as unknown as Page;
    await this.pageAccessService.validateCanView(page, user);
    return page;
  }
}
