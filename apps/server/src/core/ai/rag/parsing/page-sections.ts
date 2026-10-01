import { JSONContent } from '@tiptap/core';
import { jsonToText } from '../../../../collaboration/collaboration.util';

export interface PageSectionDraft {
  headingPath: string[];
  blockId: string | null;
  text: string;
}

interface HeadingEntry {
  level: number;
  text: string;
}

/**
 * Splits a Tiptap page body into normalized sections: one per top-level
 * block, with the heading ancestry carried in headingPath. Headings become
 * their own sections so heading text stays searchable. Tables and other
 * containers are preserved through the editor text conversion; no page
 * numbers are manufactured.
 */
export function buildPageSections(bodyJson: unknown): PageSectionDraft[] {
  const doc = bodyJson as JSONContent | null;
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) {
    return [];
  }

  const sections: PageSectionDraft[] = [];
  const headingPath: HeadingEntry[] = [];

  for (const block of doc.content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'heading') {
      const level = Number(block.attrs?.level ?? 1);
      const text = sectionText(block);
      while (
        headingPath.length > 0 &&
        headingPath[headingPath.length - 1].level >= level
      ) {
        headingPath.pop();
      }
      if (!text) {
        continue;
      }
      headingPath.push({ level, text });
      sections.push({
        headingPath: headingPath.map((entry) => entry.text),
        blockId: uniqueIdOf(block),
        text,
      });
      continue;
    }
    const text = sectionText(block);
    if (!text) {
      continue;
    }
    sections.push({
      headingPath: headingPath.map((entry) => entry.text),
      blockId: uniqueIdOf(block),
      text,
    });
  }

  return sections;
}

function sectionText(block: JSONContent): string {
  const text = jsonToText(block).trim();
  return text;
}

function uniqueIdOf(block: JSONContent): string | null {
  const uniqueId = (block.attrs as Record<string, unknown> | undefined)
    ?.uniqueId;
  return typeof uniqueId === 'string' && uniqueId ? uniqueId : null;
}
