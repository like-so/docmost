import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@Injectable()
export class AiIndexService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async indexPages(pageIds: string[], workspaceId: string) {
    if (!(await this.isSearchEnabled(workspaceId))) return;
    const pages = await this.db
      .selectFrom('pages')
      .select(['id', 'spaceId', 'title', 'textContent'])
      .where('workspaceId', '=', workspaceId)
      .where('id', 'in', pageIds)
      .where('deletedAt', 'is', null)
      .execute();
    for (const page of pages) await this.indexPage(page, workspaceId);
  }

  async removePages(pageIds: string[], workspaceId: string) {
    await this.db
      .updateTable('pageEmbeddings')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('workspaceId', '=', workspaceId)
      .where('pageId', 'in', pageIds)
      .execute();
  }

  async reindexWorkspace(workspaceId: string) {
    if (!(await this.isSearchEnabled(workspaceId))) return;
    const pages = await this.db
      .selectFrom('pages')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
    await this.indexPages(
      pages.map((page) => page.id),
      workspaceId,
    );
  }

  async removeSpace(spaceId: string, workspaceId: string) {
    await this.db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .where('spaceId', '=', spaceId)
      .execute();
  }

  async removeWorkspaceIfSearchDisabled(workspaceId: string) {
    if (await this.isSearchEnabled(workspaceId)) return;
    await this.db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async rank(
    query: string,
    pageIds: string[],
    workspaceId: string,
  ): Promise<string[]> {
    if (!pageIds.length) return [];
    const queryVector = this.embed(query);
    const rows = await this.db
      .selectFrom('pageEmbeddings')
      .select(['pageId', 'embedding'])
      .where('workspaceId', '=', workspaceId)
      .where('pageId', 'in', pageIds)
      .where('deletedAt', 'is', null)
      .execute();
    return rows
      .sort(
        (left, right) =>
          this.cosine(queryVector, right.embedding as number[]) -
          this.cosine(queryVector, left.embedding as number[]),
      )
      .map((row) => row.pageId);
  }

  private cosine(left: number[], right: number[]) {
    return left.reduce(
      (score, value, index) => score + value * (right[index] ?? 0),
      0,
    );
  }

  private async indexPage(
    page: {
      id: string;
      spaceId: string;
      title: string | null;
      textContent: string | null;
    },
    workspaceId: string,
  ) {
    const content = `${page.title ?? ''}\n${page.textContent ?? ''}`.slice(
      0,
      100000,
    );
    await this.db
      .deleteFrom('pageEmbeddings')
      .where('pageId', '=', page.id)
      .execute();
    await this.db
      .insertInto('pageEmbeddings')
      .values({
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId,
        attachmentId: null,
        modelName: 'deterministic-token-v1',
        modelDimensions: 128,
        embedding: this.embed(content) as any,
        chunkIndex: 0,
        chunkStart: 0,
        chunkLength: content.length,
        metadata: {},
      })
      .execute();
  }

  private embed(content: string): number[] {
    const vector = Array.from({ length: 128 }, () => 0);
    for (const token of content.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
      vector[this.hash(token) % vector.length] += 1;
    const length = Math.hypot(...vector) || 1;
    return vector.map((value) => value / length);
  }

  private hash(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1)
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return hash >>> 0;
  }

  private async isSearchEnabled(workspaceId: string) {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    return (
      (workspace?.settings as { ai?: { search?: boolean } } | null)?.ai
        ?.search === true
    );
  }
}
