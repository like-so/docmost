import { Module } from '@nestjs/common';
import { RAG_CHUNKER } from '../contracts';
import { RagChunker } from './chunker.service';

/**
 * Chunking adapters for the RAG contracts. Not imported by production
 * modules yet; component tests import it directly and override the port
 * tokens with adapters.
 */
@Module({
  providers: [RagChunker, { provide: RAG_CHUNKER, useExisting: RagChunker }],
  exports: [RagChunker, RAG_CHUNKER],
})
export class RagChunkingModule {}
