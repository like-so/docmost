import { Module } from '@nestjs/common';
import { RagPersistenceModule } from '../persistence/persistence.module';
import { RagRetrievalModule } from '../retrieval/retrieval.module';
import { RagHttpController } from './rag-http.controller';
import { RagSettingsService } from './rag-settings.service';
import { RagStatusService } from './rag-status.service';
import { RagReindexService } from './rag-reindex.service';

/**
 * The five POST adapters of docmost-rag-v1 contract 13. Not imported by
 * production modules yet; component tests construct the services directly
 * and bind RAG_PROFILE_CONFIG_VALIDATOR (and, via the retrieval module, the
 * resolver/embedding ports) with fixture adapters. The final wiring, including
 * the real profile validator from the embedding component, is the integration
 * component's responsibility.
 */
@Module({
  imports: [RagPersistenceModule, RagRetrievalModule],
  controllers: [RagHttpController],
  providers: [RagSettingsService, RagStatusService, RagReindexService],
  exports: [RagSettingsService, RagStatusService, RagReindexService],
})
export class RagHttpModule {}
