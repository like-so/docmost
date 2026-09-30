import * as mammoth from 'mammoth';
import { extractPagesMarkdown } from '@docmost/pdf-inspector';

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EXTRACTABLE_EXTENSIONS = new Set(['.txt', '.pdf', '.docx']);

export interface ExtractedAttachmentPage {
  /** Genuine 1-indexed page number reported by the PDF extractor. */
  pageNumber: number;
  text: string;
  needsOcr: boolean;
}

export type AttachmentExtraction =
  | { kind: 'text'; text: string }
  | { kind: 'pages'; pages: ExtractedAttachmentPage[] };

export function attachmentFileExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) {
    return '';
  }
  return fileName.slice(dot).toLowerCase();
}

export function isExtractableExtension(ext: string): boolean {
  return EXTRACTABLE_EXTENSIONS.has(ext);
}

/**
 * Normalizes the mime type used for sourcePolicy matching. When the stored
 * mime type is missing, falls back to the file extension exactly like the
 * existing attachment chat validation does.
 */
export function canonicalAttachmentMimeType(
  fileName: string,
  mimeType: string | null,
): string {
  const normalized = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (normalized) {
    return normalized;
  }
  const ext = attachmentFileExt(fileName);
  if (ext === '.txt') {
    return 'text/plain';
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  if (ext === '.docx') {
    return DOCX_MIME_TYPE;
  }
  return 'application/octet-stream';
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Reuses the existing TXT/PDF/DOCX extraction primitives. PDF text is
 * extracted per page so page numbers are real extractor output, never
 * manufactured; scanned pages are reported with needsOcr instead of
 * invented text.
 */
export async function extractAttachmentContent(
  ext: string,
  buffer: Buffer,
): Promise<AttachmentExtraction> {
  if (ext === '.txt') {
    return { kind: 'text', text: buffer.toString('utf8') };
  }
  if (ext === '.pdf') {
    const result = extractPagesMarkdown(buffer);
    return {
      kind: 'pages',
      pages: result.pages.map((page) => ({
        pageNumber: page.page + 1,
        text: page.markdown.trimEnd(),
        needsOcr: page.needsOcr,
      })),
    };
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { kind: 'text', text: result.value };
  }
  throw new Error(`Unsupported attachment extension: ${ext}`);
}
