import { BadRequestException, Injectable } from '@nestjs/common';
import * as JSZip from 'jszip';
import { EnvironmentService } from '../environment/environment.service';
import { OutboundAgentFactory } from '../outbound/outbound-agent.factory';
import * as undici from 'undici';
import { load } from 'cheerio';

@Injectable()
export class DocumentExportService {
  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly outbound: OutboundAgentFactory,
  ) {}

  async exportDocx(title: string, html: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.folder('_rels').file('.rels', rootRelationships);
    const word = zip.folder('word');
    word.file('document.xml', wordDocument(title, html));
    word.folder('_rels').file('document.xml.rels', documentRelationships);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  async exportPdf(html: string): Promise<Buffer> {
    const baseUrl = this.environmentService.getGotenbergUrl();
    if (!baseUrl) {
      throw new BadRequestException('PDF export is not configured');
    }
    const url = `${baseUrl.replace(/\/$/, '')}/forms/chromium/convert/html`;
    const lease = await this.outbound.lease(url);
    const form = new undici.FormData();
    form.append('files', new Blob([pdfDocument(html)], { type: 'text/html' }), 'index.html');
    try {
      const response = await undici.fetch(url, {
        method: 'POST',
        body: form,
        dispatcher: lease.dispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(this.environmentService.getGotenbergRequestTimeoutMs()),
      });
      if (!response.ok) {
        throw new BadRequestException('PDF conversion failed');
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      await lease.release();
    }
  }
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const documentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

function wordDocument(title: string, html: string): string {
  const paragraphs = [title, stripHtml(html)]
    .flatMap((text) => text.split(/\n+/))
    .filter(Boolean)
    .map(
      (text) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => xmlEntities[char]);
}

const xmlEntities: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};

const unsafePdfTags = [
  'applet',
  'audio',
  'base',
  'embed',
  'frame',
  'iframe',
  'img',
  'input',
  'link',
  'meta',
  'object',
  'picture',
  'script',
  'source',
  'style',
  'svg',
  'track',
  'video',
];

const resourceAttrs = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'longdesc',
  'manifest',
  'poster',
  'profile',
  'src',
  'srcset',
  'usemap',
]);

const safeStyleProps = new Set([
  'background-color',
  'border',
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'margin',
  'padding',
  'text-align',
  'text-decoration',
  'white-space',
]);

function pdfDocument(html: string): string {
  const $ = load(html, null, false);
  $(unsafePdfTags.join(',')).remove();
  $('*').each((_, element) => {
    if (!('attribs' in element)) return;
    for (const attribute of Object.keys(element.attribs)) {
      const name = attribute.toLowerCase();
      if (
        name.startsWith('on') ||
        name.endsWith('href') ||
        name.endsWith('src') ||
        resourceAttrs.has(name)
      ) {
        $(element).removeAttr(attribute);
      }
    }
    const style = $(element).attr('style');
    if (style) $(element).attr('style', safePdfStyle(style));
  });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${$.root().html()}</body></html>`;
}

function safePdfStyle(style: string): string {
  return style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const [property, ...values] = declaration.split(':');
      const name = property.trim().toLowerCase();
      const value = values.join(':').trim();
      if (!name || !value) return false;
      return (
        safeStyleProps.has(name) &&
        !/(?:url\s*\(|expression\s*\(|@import|(?:javascript|data|file):)/i.test(value)
      );
    })
    .join('; ');
}
