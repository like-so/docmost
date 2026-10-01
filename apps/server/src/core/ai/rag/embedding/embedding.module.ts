import { Module } from '@nestjs/common';
import { RAG_EMBEDDING_PORT, RAG_PROFILE_RESOLVER } from '../contracts';
import { OpenAiCompatibleEmbeddingAdapter } from './openai-compatible.embedding.adapter';
import { RagProfileResolverService } from './rag-profile.resolver';

/**
 * Profile resolution and provider-backed embeddings for the RAG contracts.
 * Component tests import it directly and override the port tokens with
 * adapters; the orchestration component (LIKE-243) wires it into production.
 */
@Module({
  providers: [
    RagProfileResolverService,
    OpenAiCompatibleEmbeddingAdapter,
    {
      provide: RAG_PROFILE_RESOLVER,
      useExisting: RagProfileResolverService,
    },
    {
      provide: RAG_EMBEDDING_PORT,
      useExisting: OpenAiCompatibleEmbeddingAdapter,
    },
  ],
  exports: [RAG_PROFILE_RESOLVER, RAG_EMBEDDING_PORT],
})
export class RagEmbeddingModule {}
