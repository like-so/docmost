import { BadRequestException } from '@nestjs/common';
import { load } from 'cheerio';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sanitizeFileName } from '../../../common/helpers';

const MAX_CONFLUENCE_PAGES = 50_000;
const MAX_CONFLUENCE_XML_BYTES = 100 * 1024 * 1024;

type ConfluencePage = {
  id: string;
  title: string;
  body: string;
  parentId: string | null;
};

export async function prepareConfluenceXml(extractDir: string): Promise<void> {
  const xmlPath = await findEntitiesXml(extractDir);
  if (!xmlPath) return;

  const xml = await fs.readFile(xmlPath, 'utf8');
  if (Buffer.byteLength(xml) > MAX_CONFLUENCE_XML_BYTES) {
    throw new BadRequestException('Confluence export metadata is too large');
  }

  ensureWellFormedXml(xml);
  const pages = parseConfluencePages(xml);
  if (pages.length === 0) {
    throw new BadRequestException('Confluence export does not contain pages');
  }

  const outputDir = path.join(extractDir, 'confluence-pages');
  const filePaths = buildConfluencePaths(pages);
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all(
    pages.map(async (page) => {
      const filePath = filePaths.get(page.id);
      const outputPath = path.join(outputDir, filePath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(
        outputPath,
        `<h1>${escapeHtml(page.title)}</h1>${replacePageLinks(page.body, filePath, filePaths)}`,
        'utf8',
      );
    }),
  );
}

export function parseConfluencePages(
  xml: string,
  maxPages = MAX_CONFLUENCE_PAGES,
): ConfluencePage[] {
  const $ = load(xml, { xmlMode: true });
  const bodyById = new Map<string, string>();
  $('object[class="BodyContent"], entity[class="BodyContent"]').each(
    (_, entry) => {
      const id = readId($, entry);
      const body = readValue($, entry, ['body']);
      if (id && body) bodyById.set(id, body);
    },
  );

  const pages: ConfluencePage[] = [];
  $('object[class="Page"], entity[class="Page"]').each((_, entry) => {
    if (pages.length >= maxPages) {
      throw new BadRequestException('Confluence export has too many pages');
    }
    const id = readId($, entry);
    const title = readValue($, entry, ['title']);
    const content = readValue($, entry, ['body', 'content', 'bodyContent']);
    const bodyId = readReference($, entry, 'bodyContent');
    if (id && title) {
      pages.push({
        id,
        title,
        body: bodyById.get(bodyId) ?? content ?? '',
        parentId: readReference($, entry, 'parent'),
      });
    }
  });
  return pages;
}

function ensureWellFormedXml(xml: string): void {
  const tags = xml.replace(
    /<!\[CDATA\[[\s\S]*?]]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g,
    '',
  );
  const stack: string[] = [];
  const expression = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(tags))) {
    const token = match[0];
    const name = match[1];
    if (token.startsWith('</')) {
      if (stack.pop() !== name) {
        throw new BadRequestException(
          'Confluence export metadata is malformed',
        );
      }
    } else if (!token.endsWith('/>') && !token.startsWith('<!')) {
      stack.push(name);
    }
  }
  if (stack.length > 0 || /<(?![!?\/A-Za-z_])/.test(tags)) {
    throw new BadRequestException('Confluence export metadata is malformed');
  }
}

function readId($: ReturnType<typeof load>, entry: any): string | null {
  return (
    readValue($, entry, ['id']) ||
    $(entry).children('id[name="id"]').first().text().trim() ||
    null
  );
}

function readValue(
  $: ReturnType<typeof load>,
  entry: any,
  names: string[],
): string | null {
  for (const name of names) {
    const value = $(entry)
      .children(`property[name="${name}"]`)
      .first()
      .text()
      .trim();
    if (value) return value;
  }
  return null;
}

function readReference(
  $: ReturnType<typeof load>,
  entry: any,
  name: string,
): string | null {
  const property = $(entry).children(`property[name="${name}"]`).first();
  return (
    property.find('id').first().text().trim() || property.text().trim() || null
  );
}

function buildConfluencePaths(pages: ConfluencePage[]): Map<string, string> {
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const paths = new Map<string, string>();
  const active = new Set<string>();
  const names = new Map<string, number>();

  const resolve = (page: ConfluencePage): string => {
    const cached = paths.get(page.id);
    if (cached) return cached;
    if (active.has(page.id)) return uniqueName(page, '', names);
    active.add(page.id);
    const parent = page.parentId ? pageById.get(page.parentId) : undefined;
    const parentFile = parent ? resolve(parent) : '';
    const parentPath = parentFile
      ? path.join(path.dirname(parentFile), path.basename(parentFile, '.html'))
      : '';
    const filePath = uniqueName(page, parentPath, names);
    active.delete(page.id);
    paths.set(page.id, filePath);
    return filePath;
  };

  for (const page of pages) resolve(page);
  return paths;
}

function uniqueName(
  page: ConfluencePage,
  parentPath: string,
  names: Map<string, number>,
): string {
  const baseName =
    sanitizeFileName(page.title).replace(/^\.+/, '') || `page-${page.id}`;
  const key = path.join(parentPath, baseName).toLowerCase();
  const count = names.get(key) ?? 0;
  names.set(key, count + 1);
  const fileName = count === 0 ? baseName : `${baseName} (${count})`;
  return path.join(parentPath, `${fileName}.html`);
}

function replacePageLinks(
  html: string,
  currentPath: string,
  paths: Map<string, string>,
): string {
  return html.replace(
    /(href=["'])[^"']*?[?&]pageId=(\d+)([^"']*["'])/gi,
    (_, prefix, pageId, suffix) => {
      const targetPath = paths.get(pageId);
      return targetPath
        ? `${prefix}${path.relative(path.dirname(currentPath), targetPath).split(path.sep).join('/')}${suffix}`
        : `${prefix}${suffix}`;
    },
  );
}

async function findEntitiesXml(extractDir: string): Promise<string | null> {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    const currentPath = path.join(extractDir, entry.name);
    if (entry.isDirectory()) {
      const found = await findEntitiesXml(currentPath);
      if (found) return found;
    } else if (entry.name.toLowerCase() === 'entities.xml') {
      return currentPath;
    }
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => htmlEntities[character]);
}

const htmlEntities: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
};
