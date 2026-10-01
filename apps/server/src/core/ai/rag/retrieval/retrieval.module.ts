import { Module } from '@nestjs/common';
import { RagPersistenceModule } from '../persistence/persistence.module';
import { RagRetrieverService } from './rag-retriever.service';

/**
 * Authorized retrieval component (docmost-rag-v1 contract 12). Not imported
 * by production modules yet; component tests construct the service directly
 * and bind RAG_PROFILE_RESOLVER / RAG_EMBEDDING_PORT with fixture adapters.
 * The final wiring (real resolver and embedding port) is the integration
 * component's responsibility.
 */
@Module({
  imports: [RagPersistenceModule],
  providers: [RagRetrieverService],
  exports: [RagRetrieverService],
})
export class RagRetrievalModule {}
