import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import {
  DocumentKey,
  IndexCause,
  IndexOperation,
  IndexRequest,
  RAG_SCHEMA_VERSION,
  SourceLedger,
} from '../contracts';
import { RagOutboxRepository } from './rag-outbox.repository';
import { RagStateRepository } from './rag-state.repository';

/**
 * The only producer of input revisions. Call it inside the same SQL
 * transaction as the authoritative source change: if that transaction rolls
 * back, neither the revision advance nor the outbox record survives.
 */
@Injectable()
export class RagSourceLedger implements SourceLedger {
  constructor(
    private readonly stateRepository: RagStateRepository,
    private readonly outboxRepository: RagOutboxRepository,
  ) {}

  async recordChange(
    trx: KyselyTransaction,
    key: DocumentKey,
    operation: IndexOperation,
    cause: IndexCause,
  ): Promise<IndexRequest> {
    const { inputRevision } = await this.stateRepository.advanceForChange(
      trx,
      key,
      operation,
      cause,
    );

    const request: IndexRequest = {
      schemaVersion: RAG_SCHEMA_VERSION,
      eventId: randomUUID(),
      key: { workspaceId: key.workspaceId, pageId: key.pageId },
      inputRevision,
      operation,
      cause,
      occurredAt: new Date().toISOString(),
    };

    await this.outboxRepository.insert(trx, request);
    return request;
  }
}
