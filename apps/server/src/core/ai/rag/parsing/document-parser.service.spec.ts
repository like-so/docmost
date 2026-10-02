import { DocumentSnapshot, IndexProfile } from '../contracts';
import {
  RagDocumentParser,
  SnapshotAttachmentReader,
  sha256Hex,
} from './document-parser.service';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('RagDocumentParser', () => {
  let reader: Map<string, Buffer>;
  let parser: RagDocumentParser;

  beforeEach(() => {
    reader = new Map<string, Buffer>();
    const attachmentReader: SnapshotAttachmentReader = {
      read: async (storageRef: string) => {
        const buffer = reader.get(storageRef);
        if (!buffer) {
          throw new Error(`missing storage object: ${storageRef}`);
        }
        return buffer;
      },
    };
    parser = new RagDocumentParser(attachmentReader);
  });

  describe('page sections', () => {
    it('builds sections with heading paths, block ids and stable hashes', async () => {
      const snapshot = makeSnapshot({
        bodyJson: doc([
          heading(1, 'Intro', 'h1-id'),
          paragraph('First paragraph.', 'p1-id'),
          heading(2, 'Details', 'h2-id'),
          paragraph('Nested paragraph.', 'p2-id'),
        ]),
      });

      const result = await parser.normalize(snapshot, makeProfile());

      expect(result.sections).toHaveLength(4);
      const [h1, p1, h2, p2] = result.sections;
      expect(h1.text).toBe('Intro');
      expect(h1.headingPath).toEqual(['Intro']);
      expect(h1.blockId).toBe('h1-id');
      expect(p1.text).toBe('First paragraph.');
      expect(p1.headingPath).toEqual(['Intro']);
      expect(p1.blockId).toBe('p1-id');
      expect(h2.text).toBe('Details');
      expect(h2.headingPath).toEqual(['Intro', 'Details']);
      expect(p2.headingPath).toEqual(['Intro', 'Details']);
      for (const section of result.sections) {
        expect(section.source).toEqual({ kind: 'page' });
        expect(section.textHash).toBe(sha256Hex(section.text));
        expect(section.pageNumber).toBeNull();
      }
    });

    it('pops heading path entries at the same or higher level', async () => {
      const snapshot = makeSnapshot({
        bodyJson: doc([
          heading(1, 'A', 'h-a'),
          heading(2, 'B', 'h-b'),
          heading(1, 'C', 'h-c'),
          paragraph('After C.', 'p-c'),
        ]),
      });

      const result = await parser.normalize(snapshot, makeProfile());
      const afterC = result.sections[result.sections.length - 1];
      expect(afterC.headingPath).toEqual(['C']);
    });

    it('preserves table text inside a section', async () => {
      const snapshot = makeSnapshot({
        bodyJson: doc([
          table([
            ['Alpha', 'Beta'],
            ['Gamma', 'Delta'],
          ]),
        ]),
      });

      const result = await parser.normalize(snapshot, makeProfile());

      expect(result.sections).toHaveLength(1);
      const tableSection = result.sections[0];
      expect(tableSection.text).toContain('Alpha');
      expect(tableSection.text).toContain('Beta');
      expect(tableSection.text).toContain('Gamma');
      expect(tableSection.text).toContain('Delta');
      expect(tableSection.source).toEqual({ kind: 'page' });
    });

    it('is deterministic for the same snapshot and profile', async () => {
      const snapshot = makeSnapshot({
        bodyJson: doc([heading(1, 'Intro', 'h1'), paragraph('Body.', 'p1')]),
        attachments: [txtAttachment()],
      });
      reader.set('ref-txt', Buffer.from('Attached text.'));

      const first = await parser.normalize(snapshot, makeProfile());
      const second = await parser.normalize(snapshot, makeProfile());

      expect(second).toEqual(first);
    });

    it('returns no sections for an empty body', async () => {
      const result = await parser.normalize(makeSnapshot({}), makeProfile());
      expect(result.sections).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe('attachment policy', () => {
    it('emits an attachment section for a required txt attachment', async () => {
      reader.set('ref-txt', Buffer.from('Attached text.\nSecond line.'));
      const snapshot = makeSnapshot({ attachments: [txtAttachment()] });

      const result = await parser.normalize(snapshot, makeProfile());

      expect(result.sections).toHaveLength(1);
      const section = result.sections[0];
      expect(section.source).toEqual({
        kind: 'attachment',
        attachmentId: 'a-txt',
      });
      expect(section.text).toBe('Attached text.\nSecond line.');
      expect(section.headingPath).toEqual([]);
      expect(section.blockId).toBeNull();
      expect(section.pageNumber).toBeNull();
      expect(result.diagnostics).toEqual([]);
    });

    it('marks a non-required source as excluded by policy', async () => {
      const snapshot = makeSnapshot({
        attachments: [
          {
            attachmentId: 'a-excluded',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
            byteSize: 10,
            sourceHash: null,
            storageRef: 'ref-excluded',
          },
        ],
      });
      const profile = makeProfile({
        sourcePolicy: {
          requiredMimeTypes: ['application/pdf'],
          imageInterpretation: 'disabled',
        },
      });

      const result = await parser.normalize(snapshot, profile);

      expect(result.sections).toEqual([]);
      expect(result.diagnostics).toEqual([
        { sourceId: 'a-excluded', code: 'EXCLUDED_BY_POLICY' },
      ]);
    });

    it('marks a required unsupported mime type as SOURCE_UNSUPPORTED', async () => {
      const snapshot = makeSnapshot({
        attachments: [
          {
            attachmentId: 'a-zip',
            fileName: 'archive.zip',
            mimeType: 'application/zip',
            byteSize: 100,
            sourceHash: null,
            storageRef: 'ref-zip',
          },
        ],
      });
      const profile = makeProfile({
        sourcePolicy: {
          requiredMimeTypes: ['application/zip'],
          imageInterpretation: 'disabled',
        },
      });

      const result = await parser.normalize(snapshot, profile);

      expect(result.sections).toEqual([]);
      expect(result.diagnostics).toEqual([
        { sourceId: 'a-zip', code: 'SOURCE_UNSUPPORTED' },
      ]);
    });

    it('treats images as unsupported when interpretation is required', async () => {
      const snapshot = makeSnapshot({
        attachments: [
          {
            attachmentId: 'a-img',
            fileName: 'diagram.png',
            mimeType: 'image/png',
            byteSize: 100,
            sourceHash: null,
            storageRef: 'ref-img',
          },
        ],
      });
      const profile = makeProfile({
        sourcePolicy: {
          requiredMimeTypes: ['application/pdf'],
          imageInterpretation: 'required',
        },
      });

      const result = await parser.normalize(snapshot, profile);

      expect(result.diagnostics).toEqual([
        { sourceId: 'a-img', code: 'SOURCE_UNSUPPORTED' },
      ]);
      expect(result.sections).toEqual([]);
    });

    it('excludes images by policy when interpretation is disabled', async () => {
      const snapshot = makeSnapshot({
        attachments: [
          {
            attachmentId: 'a-img',
            fileName: 'diagram.png',
            mimeType: 'image/png',
            byteSize: 100,
            sourceHash: null,
            storageRef: 'ref-img',
          },
        ],
      });

      const result = await parser.normalize(snapshot, makeProfile());

      expect(result.diagnostics).toEqual([
        { sourceId: 'a-img', code: 'EXCLUDED_BY_POLICY' },
      ]);
    });

    it('marks a failed required extraction as SOURCE_UNSUPPORTED', async () => {
      const snapshot = makeSnapshot({ attachments: [txtAttachment()] });
      // no buffer registered for 'ref-txt': read fails

      const result = await parser.normalize(snapshot, makeProfile());

      expect(result.sections).toEqual([]);
      expect(result.diagnostics).toEqual([
        { sourceId: 'a-txt', code: 'SOURCE_UNSUPPORTED' },
      ]);
    });
  });

  describe('pdf and docx extraction', () => {
    it('creates one section per pdf page with genuine page numbers', async () => {
      reader.set(
        'ref-pdf',
        makePdf([
          'Page one content.',
          'Page two content with more words on it.',
        ]),
      );
      const snapshot = makeSnapshot({ attachments: [pdfAttachment()] });

      const result = await parser.normalize(snapshot, makeProfile());

      const pdfSections = result.sections.filter(
        (section) => section.source.kind === 'attachment',
      );
      expect(pdfSections).toHaveLength(2);
      expect(pdfSections[0].pageNumber).toBe(1);
      expect(pdfSections[0].text).toContain('Page one content.');
      expect(pdfSections[1].pageNumber).toBe(2);
      expect(pdfSections[1].text).toContain('Page two content');
      expect(result.diagnostics).toEqual([]);
    });

    it('extracts docx paragraph text', async () => {
      reader.set(
        'ref-docx',
        makeDocx(['Docx first paragraph.', 'Docx second paragraph.']),
      );
      const snapshot = makeSnapshot({ attachments: [docxAttachment()] });

      const result = await parser.normalize(snapshot, makeProfile());

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].text).toContain('Docx first paragraph.');
      expect(result.sections[0].text).toContain('Docx second paragraph.');
      expect(result.diagnostics).toEqual([]);
    });
  });
});

function makeProfile(overrides?: Partial<IndexProfile>): IndexProfile {
  return {
    profileId: '11111111-1111-4111-8111-111111111111',
    profileHash: 'profile-hash-1',
    parserVersion: '1',
    chunkerVersion: '1',
    maxChunkTokens: 512,
    overlapTokens: 64,
    sourcePolicy: {
      requiredMimeTypes: ['text/plain', 'application/pdf', DOCX_MIME],
      imageInterpretation: 'disabled',
    },
    embedding: {
      driver: 'openai-compatible',
      endpointIdentity: 'default',
      model: 'gpt-4o-mini',
      dimensions: 1536,
      tokenizerId: 'o200k_base',
      maxInputTokens: 128000,
    },
    ...overrides,
  } as IndexProfile;
}

function makeSnapshot(
  overrides: Partial<DocumentSnapshot> = {},
): DocumentSnapshot {
  return {
    key: {
      workspaceId: '22222222-2222-4222-8222-222222222222',
      pageId: '33333333-3333-4333-8333-333333333333',
    },
    inputRevision: '7',
    title: 'Test page',
    spaceId: '44444444-4444-4444-8444-444444444444',
    bodyJson: null,
    bodyText: '',
    attachments: [],
    ...overrides,
  };
}

function txtAttachment() {
  return {
    attachmentId: 'a-txt',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    byteSize: 30,
    sourceHash: null,
    storageRef: 'ref-txt',
  };
}

function pdfAttachment() {
  return {
    attachmentId: 'a-pdf',
    fileName: 'document.pdf',
    mimeType: 'application/pdf',
    byteSize: 1000,
    sourceHash: null,
    storageRef: 'ref-pdf',
  };
}

function docxAttachment() {
  return {
    attachmentId: 'a-docx',
    fileName: 'document.docx',
    mimeType: DOCX_MIME,
    byteSize: 1000,
    sourceHash: null,
    storageRef: 'ref-docx',
  };
}

function doc(content: unknown[]): unknown {
  return { type: 'doc', content };
}

function heading(level: number, text: string, uniqueId: string): unknown {
  return {
    type: 'heading',
    attrs: { level, uniqueId },
    content: [{ type: 'text', text }],
  };
}

function paragraph(text: string, uniqueId: string): unknown {
  return {
    type: 'paragraph',
    attrs: { uniqueId },
    content: [{ type: 'text', text }],
  };
}

function table(rows: string[][]): unknown {
  return {
    type: 'table',
    content: rows.map((cells) => ({
      type: 'tableRow',
      content: cells.map((cell) => ({
        type: 'tableCell',
        attrs: { textAlign: 'left' },
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: 'left' },
            content: [{ type: 'text', text: cell }],
          },
        ],
      })),
    })),
  };
}

/** Minimal single/multi-page PDF with one text run per page. */
function makePdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  const fontId = 3 + pageTexts.length * 2 + 1;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [PAGES] /Count COUNT >>';
  pageTexts.forEach((pageText, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(pageText)}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[contentId] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[2] = objects[2]
    .replace('PAGES', pageIds.map((id) => `${id} 0 R`).join(' '))
    .replace('COUNT', String(pageIds.length));

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function escapePdfText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal stored-entry ZIP containing the OOXML parts mammoth needs. */
function makeDocx(paragraphs: string[]): Buffer {
  const escapeXml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs
      .map(
        (text) =>
          `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
      )
      .join('') +
    '</w:body></w:document>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}"/>` +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  return makeStoredZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

function makeStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
