import { Module } from '@nestjs/common';
import { StorageModule } from '../../../../integrations/storage/storage.module';
import { RAG_DOCUMENT_PARSER } from '../contracts';
import {
  RagDocumentParser,
  SNAPSHOT_ATTACHMENT_READER,
  StorageSnapshotAttachmentReader,
} from './document-parser.service';

/**
 * Parsing adapters for the RAG contracts. Not imported by production
 * modules yet; component tests import it directly and override the port
 * tokens with adapters.
 */
@Module({
  imports: [StorageModule],
  providers: [
    StorageSnapshotAttachmentReader,
    {
      provide: SNAPSHOT_ATTACHMENT_READER,
      useExisting: StorageSnapshotAttachmentReader,
    },
    RagDocumentParser,
    { provide: RAG_DOCUMENT_PARSER, useExisting: RagDocumentParser },
  ],
  exports: [RagDocumentParser, RAG_DOCUMENT_PARSER],
})
export class RagParsingModule {}
