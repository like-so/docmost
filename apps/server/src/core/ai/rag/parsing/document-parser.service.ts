import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { StorageService } from '../../../../integrations/storage/storage.service';
import {
  DocumentParser,
  DocumentSnapshot,
  IndexProfile,
  NormalizedDocument,
  NormalizedSection,
  ParseDiagnostic,
} from '../contracts';
import {
  attachmentFileExt,
  canonicalAttachmentMimeType,
  extractAttachmentContent,
  isExtractableExtension,
  isImageMimeType,
} from './attachment-extraction';
import { buildPageSections } from './page-sections';

export const SNAPSHOT_ATTACHMENT_READER = Symbol('SNAPSHOT_ATTACHMENT_READER');

export interface SnapshotAttachmentReader {
  read(storageRef: string): Promise<Buffer>;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

@Injectable()
export class RagDocumentParser implements DocumentParser {
  constructor(
    @Inject(SNAPSHOT_ATTACHMENT_READER)
    private readonly attachmentReader: SnapshotAttachmentReader,
  ) {}

  async normalize(
    snapshot: DocumentSnapshot,
    indexProfile: IndexProfile,
  ): Promise<NormalizedDocument> {
    const sections: NormalizedSection[] = [];
    const diagnostics: ParseDiagnostic[] = [];

    for (const draft of buildPageSections(snapshot.bodyJson)) {
      sections.push({
        source: { kind: 'page' },
        headingPath: draft.headingPath,
        blockId: draft.blockId,
        pageNumber: null,
        text: draft.text,
        textHash: sha256Hex(draft.text),
      });
    }

    for (const attachment of snapshot.attachments) {
      const mimeType = canonicalAttachmentMimeType(
        attachment.fileName,
        attachment.mimeType,
      );
      const required = isRequiredSource(
        mimeType,
        attachment.fileName,
        indexProfile,
      );
      if (!required) {
        diagnostics.push({
          sourceId: attachment.attachmentId,
          code: 'EXCLUDED_BY_POLICY',
        });
        continue;
      }

      const ext = attachmentFileExt(attachment.fileName);
      if (!isExtractableExtension(ext)) {
        diagnostics.push({
          sourceId: attachment.attachmentId,
          code: 'SOURCE_UNSUPPORTED',
        });
        continue;
      }

      try {
        const buffer = await this.attachmentReader.read(attachment.storageRef);
        const extraction = await extractAttachmentContent(ext, buffer);
        if (extraction.kind === 'text') {
          if (extraction.text.length > 0) {
            sections.push(
              attachmentSection(attachment.attachmentId, extraction.text),
            );
          }
        } else {
          let unsupportedPage = false;
          for (const page of extraction.pages) {
            if (page.needsOcr) {
              unsupportedPage = true;
              continue;
            }
            if (!page.text) {
              continue;
            }
            sections.push({
              source: {
                kind: 'attachment',
                attachmentId: attachment.attachmentId,
              },
              headingPath: [],
              blockId: null,
              pageNumber: page.pageNumber,
              text: page.text,
              textHash: sha256Hex(page.text),
            });
          }
          if (unsupportedPage) {
            diagnostics.push({
              sourceId: attachment.attachmentId,
              code: 'SOURCE_UNSUPPORTED',
            });
          }
        }
      } catch {
        diagnostics.push({
          sourceId: attachment.attachmentId,
          code: 'SOURCE_UNSUPPORTED',
        });
      }
    }

    return {
      key: {
        workspaceId: snapshot.key.workspaceId,
        pageId: snapshot.key.pageId,
      },
      inputRevision: snapshot.inputRevision,
      sections,
      diagnostics,
    };
  }
}

function isRequiredSource(
  mimeType: string,
  fileName: string,
  indexProfile: IndexProfile,
): boolean {
  if (indexProfile.sourcePolicy.requiredMimeTypes.includes(mimeType)) {
    return true;
  }
  if (
    isImageMimeType(mimeType) &&
    !isExtractableExtension(attachmentFileExt(fileName))
  ) {
    return indexProfile.sourcePolicy.imageInterpretation === 'required';
  }
  return false;
}

function attachmentSection(
  attachmentId: string,
  text: string,
): NormalizedSection {
  return {
    source: { kind: 'attachment', attachmentId },
    headingPath: [],
    blockId: null,
    pageNumber: null,
    text,
    textHash: sha256Hex(text),
  };
}

@Injectable()
export class StorageSnapshotAttachmentReader implements SnapshotAttachmentReader {
  constructor(private readonly storageService: StorageService) {}

  read(storageRef: string): Promise<Buffer> {
    return this.storageService.read(storageRef);
  }
}
