import { Module } from '@nestjs/common';
import { RAG_SOURCE_LEDGER } from '../contracts';
import { RagOutboxRepository } from './rag-outbox.repository';
import { RagSourceLedger } from './rag-source-ledger';
import { RagStateRepository } from './rag-state.repository';

/**
 * Persistence adapters for the RAG contracts. Not imported by production
 * modules yet; component tests import it directly and override the port
 * tokens with adapters.
 */
@Module({
  providers: [
    RagStateRepository,
    RagOutboxRepository,
    RagSourceLedger,
    { provide: RAG_SOURCE_LEDGER, useExisting: RagSourceLedger },
  ],
  exports: [RagStateRepository, RagOutboxRepository, RAG_SOURCE_LEDGER],
})
export class RagPersistenceModule {}
