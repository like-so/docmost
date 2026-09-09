import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { JsonObject, JsonValue } from '@docmost/db/types/db';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../page/services/page.service';
import { PageAccessService } from '../page/page-access/page-access.service';
import { User } from '@docmost/db/types/entity.types';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { v7 as uuid7 } from 'uuid';
import { csvCell, parseCsv } from './base-csv';
import { evaluateFormula } from './base-formula';
import { validateViewConfig } from './base-view-config';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

export const BASE_TYPES = ['text', 'longText', 'number', 'boolean', 'date', 'select', 'multiSelect', 'person', 'files', 'formula'] as const;
export type BaseType = (typeof BASE_TYPES)[number];
type BaseCells = Record<string, JsonValue>;

@Injectable()
export class BaseService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pages: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccess: PageAccessService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async get(pageId: string, user: User) {
    const page = await this.requireBase(pageId, user, false);
    const [properties, rows, views] = await Promise.all([
      this.db.selectFrom('baseProperties').selectAll().where('pageId', '=', page.id).where('deletedAt', 'is', null).orderBy('position').execute(),
      this.db.selectFrom('baseRows').selectAll().where('pageId', '=', page.id).where('deletedAt', 'is', null).orderBy('position').execute(),
      this.db.selectFrom('baseViews').selectAll().where('pageId', '=', page.id).orderBy('position').execute(),
    ]);
    return { page, properties, rows: this.withFormulas(rows, properties), views, permissions: await this.permissions(page, user) };
  }

  async create(parentPageId: string, user: User, template?: string) {
    const parent = await this.pages.findById(parentPageId);
    if (!parent || parent.deletedAt) throw new NotFoundException('Parent page not found');
    await this.pageAccess.validateCanEdit(parent, user);
    return this.db.transaction().execute(async (trx) => {
      const page = await this.pageService.create(user.id, parent.workspaceId, { spaceId: parent.spaceId, parentPageId: parent.id, title: template === 'kanban' ? 'Board' : 'Untitled base' }, trx, true);
      await this.seed(page.id, page.workspaceId, user.id, trx);
      await this.auditService.logWithContextInTransaction({ event: AuditEvent.BASE_UPDATED, resourceType: AuditResource.BASE, resourceId: page.id, spaceId: page.spaceId, metadata: { action: 'created' } }, { workspaceId: page.workspaceId, actorId: user.id }, trx);
      return page;
    });
  }

  async convert(pageId: string, user: User) {
    const page = await this.requirePage(pageId, user, true);
    if (!page.isBase) {
      await this.db.transaction().execute(async (trx) => {
        const converted = await trx.updateTable('pages').set({ isBase: true, baseSchemaVersion: 1, updatedAt: new Date() }).where('id', '=', page.id).where('isBase', '=', false).returning('id').executeTakeFirst();
        if (!converted) throw new ConflictException('Page has already been converted');
        await this.seed(page.id, page.workspaceId, user.id, trx);
        await this.auditService.logWithContextInTransaction({ event: AuditEvent.BASE_UPDATED, resourceType: AuditResource.BASE, resourceId: page.id, spaceId: page.spaceId, metadata: { action: 'converted' } }, { workspaceId: page.workspaceId, actorId: user.id }, trx);
      });
    }
    return this.get(page.id, user);
  }

  async addProperty(pageId: string, user: User, input: { name: string; type: BaseType; formula?: string }, version: number) {
    const page = await this.requireBase(pageId, user, true);
    this.validateType(input.type);
    const name = this.name(input.name);
    const duplicate = await this.db.selectFrom('baseProperties').select('id').where('pageId', '=', page.id).where('deletedAt', 'is', null).where('name', '=', name).executeTakeFirst();
    if (duplicate) throw new ConflictException('Property name already exists');
    const position = await this.next('baseProperties', page.id);
    return this.mutate(page, user, version, (db) => db.insertInto('baseProperties').values({ id: uuid7(), pageId: page.id, workspaceId: page.workspaceId, name, type: input.type, typeOptions: this.typeOptions(input.type, input.formula), position }).returningAll().executeTakeFirst());
  }

  async updateProperty(pageId: string, propertyId: string, user: User, input: { name?: string; type?: BaseType; formula?: string; position?: string }, version: number) {
    const page = await this.requireBase(pageId, user, true);
    if (input.type) this.validateType(input.type);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = this.name(input.name);
    if (input.type !== undefined) { updates.type = input.type; updates.typeOptions = this.typeOptions(input.type, input.formula); }
    if (input.position !== undefined) updates.position = this.position(input.position);
    const result = await this.mutate(page, user, version, (db) => db.updateTable('baseProperties').set(updates).where('pageId', '=', page.id).where('id', '=', propertyId).where('deletedAt', 'is', null).returningAll().executeTakeFirst());
    if (!result) throw new NotFoundException('Property not found');
    return result;
  }

  async removeProperty(pageId: string, propertyId: string, user: User, version: number) {
    const page = await this.requireBase(pageId, user, true);
    const result = await this.mutate(page, user, version, (db) => db.updateTable('baseProperties').set({ deletedAt: new Date(), updatedAt: new Date() }).where('pageId', '=', page.id).where('id', '=', propertyId).where('deletedAt', 'is', null).returning('id').executeTakeFirst());
    if (!result) throw new NotFoundException('Property not found');
  }

  async addRow(pageId: string, user: User, cells: BaseCells, version: number) {
    const page = await this.requireBase(pageId, user, true);
    await this.validateCells(page.id, cells);
    return this.mutate(page, user, version, async (trx) => {
      const position = await this.next('baseRows', page.id, trx);
      return trx.insertInto('baseRows').values({ pageId: page.id, workspaceId: page.workspaceId, cells, position, creatorId: user.id, lastUpdatedById: user.id }).returningAll().executeTakeFirst();
    });
  }

  async updateRow(pageId: string, rowId: string, user: User, input: { cells?: BaseCells; position?: string; version: number }) {
    const page = await this.requireBase(pageId, user, true);
    if (page.baseSchemaVersion !== input.version) throw new ConflictException({ message: 'Base has changed', version: page.baseSchemaVersion });
    if (input.cells) await this.validateCells(page.id, input.cells);
    const updates: Record<string, unknown> = { lastUpdatedById: user.id, updatedAt: new Date() };
    if (input.cells) updates.cells = input.cells;
    if (input.position) updates.position = this.position(input.position);
    return this.db.transaction().execute(async (trx) => {
      const schema = await trx
        .updateTable('pages')
        .set((expression) => ({
          baseSchemaVersion: expression('baseSchemaVersion', '+', 1),
          updatedAt: new Date(),
        }))
        .where('id', '=', page.id)
        .where('baseSchemaVersion', '=', input.version)
        .returning('baseSchemaVersion')
        .executeTakeFirst();
      if (!schema)
        throw new ConflictException({
          message: 'Base has changed',
          version: input.version,
        });
      const row = await trx
        .updateTable('baseRows')
        .set(updates)
        .where('pageId', '=', page.id)
        .where('id', '=', rowId)
        .where('deletedAt', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Row not found');
      await this.auditService.logWithContextInTransaction({ event: AuditEvent.BASE_UPDATED, resourceType: AuditResource.BASE, resourceId: page.id, spaceId: page.spaceId, metadata: { action: 'row_updated', rowId } }, { workspaceId: page.workspaceId, actorId: user.id }, trx);
      return row;
    });
  }

  async removeRow(pageId: string, rowId: string, user: User, version: number) {
    const page = await this.requireBase(pageId, user, true);
    const row = await this.mutate(page, user, version, (trx) => trx.updateTable('baseRows').set({ deletedAt: new Date(), updatedAt: new Date() }).where('pageId', '=', page.id).where('id', '=', rowId).where('deletedAt', 'is', null).returning('id').executeTakeFirst());
    if (!row) throw new NotFoundException('Row not found');
  }

  async saveView(pageId: string, user: User, input: { id?: string; name: string; type?: string; config?: JsonObject; position?: string }, version: number) {
    const page = await this.requireBase(pageId, user, true);
    const name = this.name(input.name);
    const config = validateViewConfig(input.config ?? {});
    if (input.id) {
      const view = await this.mutate(page, user, version, async (db) => {
        const position = input.position ? this.position(input.position) : await this.next('baseViews', page.id, db);
        return db.updateTable('baseViews').set({ name, type: input.type ?? 'table', config, position, updatedAt: new Date() }).where('id', '=', input.id).where('pageId', '=', page.id).returningAll().executeTakeFirst();
      });
      if (!view) throw new NotFoundException('View not found');
      return view;
    }
    return this.mutate(page, user, version, async (db) => {
      const position = input.position ? this.position(input.position) : await this.next('baseViews', page.id, db);
      return db.insertInto('baseViews').values({ pageId: page.id, workspaceId: page.workspaceId, creatorId: user.id, name, type: input.type ?? 'table', config, position }).returningAll().executeTakeFirst();
    });
  }

  async removeView(pageId: string, viewId: string, user: User, version: number) {
    const page = await this.requireBase(pageId, user, true);
    const view = await this.mutate(page, user, version, (db) => db.deleteFrom('baseViews').where('pageId', '=', page.id).where('id', '=', viewId).returning('id').executeTakeFirst());
    if (!view) throw new NotFoundException('View not found');
  }

  async importCsv(pageId: string, user: User, csv: string, version: number) {
    const page = await this.requireBase(pageId, user, true);
    const [header, ...data] = parseCsv(csv);
    if (!header?.length || header.some((value) => !value.trim())) throw new BadRequestException('CSV header is required');
    return this.mutate(page, user, version, async (trx) => {
      const properties = await trx.selectFrom('baseProperties').select(['id', 'name', 'type']).where('pageId', '=', page.id).where('deletedAt', 'is', null).execute();
      const rows = this.csvRows(header, data, properties, page, user);
      await Promise.all(rows.map((row) => this.validateCells(page.id, row.cells, trx)));
      if (rows.length) await trx.insertInto('baseRows').values(rows).execute();
      return { imported: rows.length };
    });
  }

  async exportCsv(pageId: string, user: User) {
    const base = await this.get(pageId, user);
    const names = base.properties.map((property) => property.name);
    const ids = base.properties.map((property) => property.id);
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    return [names.map(quote).join(','), ...base.rows.map((row) => ids.map((id) => quote((row.cells as BaseCells)[id])).join(','))].join('\r\n');
  }

  private async requirePage(pageId: string, user: User, edit: boolean) {
    const page = await this.pages.findById(pageId);
    if (!page || page.deletedAt) throw new NotFoundException('Base not found');
    if (edit) await this.pageAccess.validateCanEdit(page, user); else await this.pageAccess.validateCanView(page, user);
    return page;
  }

  private async requireBase(pageId: string, user: User, edit: boolean) {
    const page = await this.requirePage(pageId, user, edit);
    if (!page.isBase) throw new NotFoundException('Base not found');
    return page;
  }

  private async permissions(page: Parameters<PageAccessService['validateCanEdit']>[0], user: User) {
    try { await this.pageAccess.validateCanEdit(page, user); return { canEdit: true }; } catch (error) { if (error instanceof ForbiddenException) return { canEdit: false }; throw error; }
  }

  private async mutate<T>(page: { id: string; workspaceId: string; spaceId: string; baseSchemaVersion: number }, user: User, version: number, change: (db: KyselyTransaction) => Promise<T>): Promise<T> {
    if (page.baseSchemaVersion !== version) throw new ConflictException({ message: 'Base has changed', version: page.baseSchemaVersion });
    return this.db.transaction().execute(async (trx) => {
      const changed = await trx.updateTable('pages').set((expression) => ({ baseSchemaVersion: expression('baseSchemaVersion', '+', 1), updatedAt: new Date() })).where('id', '=', page.id).where('baseSchemaVersion', '=', version).returning('baseSchemaVersion').executeTakeFirst();
      if (!changed) throw new ConflictException({ message: 'Base has changed', version });
      const result = await change(trx);
      await this.auditService.logWithContextInTransaction({ event: AuditEvent.BASE_UPDATED, resourceType: AuditResource.BASE, resourceId: page.id, spaceId: page.spaceId, metadata: { action: 'mutated' } }, { workspaceId: page.workspaceId, actorId: user.id }, trx);
      return result;
    });
  }

  private async seed(pageId: string, workspaceId: string, userId: string, db: KyselyDB | KyselyTransaction = this.db) {
    const values = [
      { id: uuid7(), pageId, workspaceId, name: 'Name', type: 'text', position: 'a0', isPrimary: true },
      { id: uuid7(), pageId, workspaceId, name: 'Status', type: 'select', position: 'a1' },
      { id: uuid7(), pageId, workspaceId, name: 'Notes', type: 'text', position: 'a2' },
    ];
    await db.insertInto('baseProperties').values(values).execute();
    await db.insertInto('baseViews').values({ pageId, workspaceId, creatorId: userId, name: 'Table', type: 'table', position: 'a0', config: {} }).execute();
  }

  private csvRows(header: string[], data: string[][], properties: Array<{ id: string; name: string; type: string }>, page: { id: string; workspaceId: string }, user: User) {
    const byName = new Map(properties.map((property) => [property.name.toLowerCase(), property]));
    if (header.some((name) => !byName.has(name.trim().toLowerCase()))) throw new BadRequestException('CSV columns must match existing properties');
    return data.map((values, index) => ({ pageId: page.id, workspaceId: page.workspaceId, cells: Object.fromEntries(values.map((value, column) => {
      const property = byName.get(header[column].trim().toLowerCase())!;
      if (property.type === 'formula') throw new BadRequestException('Formula columns cannot be imported');
      return [property.id, csvCell(value, property.type)];
    })), position: `csv${String(index).padStart(8, '0')}`, creatorId: user.id, lastUpdatedById: user.id }));
  }

  private async next(table: 'baseProperties' | 'baseRows' | 'baseViews', pageId: string, db: KyselyDB | KyselyTransaction = this.db) {
    const last = await db.selectFrom(table).select('position').where('pageId', '=', pageId).orderBy('position', 'desc').executeTakeFirst();
    return generateJitteredKeyBetween(last?.position ?? null, null);
  }

  private async validateCells(pageId: string, cells: BaseCells, db: KyselyDB | KyselyTransaction = this.db) {
    const properties = await db.selectFrom('baseProperties').select(['id', 'type']).where('pageId', '=', pageId).where('deletedAt', 'is', null).execute();
    const types = new Map(properties.map((property) => [property.id, property.type]));
    for (const [id, value] of Object.entries(cells)) {
      const type = types.get(id);
      if (!type || !this.validCell(type as BaseType, value)) throw new BadRequestException(`Invalid cell for property ${id}`);
    }
  }

  private validCell(type: BaseType, value: unknown) {
    if (value === null) return true;
    if (type === 'formula') return value === null;
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'multiSelect' || type === 'person') return Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string');
    if (type === 'files') return Array.isArray(value) && value.length <= 50 && value.every((item) => typeof item === 'string');
    if (typeof value !== 'string') return false;
    return value.length <= (type === 'longText' ? 25000 : 1000);
  }

  private withFormulas(rows: Array<{ cells: JsonValue }>, properties: Array<{ id: string; name: string; type: string; typeOptions: JsonValue | null }>) {
    const names = new Map(properties.map((property) => [property.name, property.id]));
    const formulas = properties.filter((property) => property.type === 'formula');
    return rows.map((row) => {
      const cells = this.jsonObject(row.cells);
      return { ...row, cells: formulas.reduce((result, property) => ({ ...result, [property.id]: evaluateFormula(this.formula(property.typeOptions), result, names) }), cells) };
    });
  }

  private typeOptions(type: BaseType, formula?: string) {
    if (type !== 'formula') return null;
    evaluateFormula(formula ?? '', {}, new Map());
    return { formula };
  }

  private jsonObject(value: JsonValue): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

  private formula(options: JsonValue | null) { return options && typeof options === 'object' && !Array.isArray(options) && typeof options.formula === 'string' ? options.formula : ''; }

  private validateType(type: string) { if (!BASE_TYPES.includes(type as BaseType)) throw new BadRequestException('Invalid property type'); }
  private name(name: string) { const value = name?.trim(); if (!value || value.length > 100) throw new BadRequestException('Property name is required'); return value; }
  private position(position: string) { if (!/^[A-Za-z0-9]+$/.test(position) || position.length > 64) throw new BadRequestException('Invalid position'); return position; }
}
