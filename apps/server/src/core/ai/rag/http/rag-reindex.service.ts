import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User, Workspace } from '@docmost/db/types/entity.types';
import {
  RagReindexResponse,
  RAG_SOURCE_LEDGER,
  SourceLedger,
} from '../contracts';
import { PageAccessService } from '../../../page/page-access/page-access.service';

/**
 * Manual reindex adapter (docmost-rag-v1 contract 13). Requires current edit
 * permission and records a durable manual request through the source ledger
 * in the same transaction; the outbox relay and queue delivery belong to
 * orchestration, so the reported phase is always the freshly recorded
 * 'pending' state, never a recycled one.
 */
@Injectable()
export class RagReindexService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(RAG_SOURCE_LEDGER) private readonly sourceLedger: SourceLedger,
    private readonly pageAccessService: PageAccessService,
  ) {}

  async reindex(
    user: User,
    workspace: Workspace,
    pageId: string,
  ): Promise<RagReindexResponse> {
    await this.loadEditablePage(user, workspace, pageId);

    const request = await this.db
      .transaction()
      .execute((trx) =>
        this.sourceLedger.recordChange(
          trx,
          { workspaceId: workspace.id, pageId },
          'upsert',
          'manual',
        ),
      );

    return {
      eventId: request.eventId,
      inputRevision: request.inputRevision,
      phase: 'pending',
    };
  }

  private async loadEditablePage(
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
    await this.pageAccessService.validateCanEdit(page, user);
    return page;
  }
}
