import { Module } from '@nestjs/common';
import { RAG_SOURCE_READER } from '../contracts';
import { RagPersistenceModule } from '../persistence/persistence.module';
import { RagSourceReader } from './rag-source.reader';

/**
 * Source adapter for the RAG contracts. StorageService comes from the global
 * StorageModule registration; this module only composes the persistence
 * adapters with the reader and exposes the contract token.
 */
@Module({
  imports: [RagPersistenceModule],
  providers: [
    RagSourceReader,
    { provide: RAG_SOURCE_READER, useExisting: RagSourceReader },
  ],
  exports: [RagSourceReader, RAG_SOURCE_READER],
})
export class RagSourceModule {}
