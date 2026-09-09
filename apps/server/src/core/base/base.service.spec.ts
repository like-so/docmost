import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BaseService } from './base.service';

describe('BaseService', () => {
  const user: any = { id: 'user', workspaceId: 'workspace' };
  function create() {
    const query: any = {
      executeTakeFirst: jest.fn().mockResolvedValue(undefined),
      orderBy: jest.fn(),
      select: jest.fn(),
      where: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    const db: any = { selectFrom: jest.fn().mockReturnValue(query) };
    const pages: any = { findById: jest.fn() };
    const pageService: any = {};
    const access: any = { validateCanEdit: jest.fn(), validateCanView: jest.fn() };
    return { service: new BaseService(db, pages, pageService, access, { logWithContextInTransaction: jest.fn() } as any), pages, access };
  }

  it('rejects a non-base page after authorizing view access', async () => {
    const { service, pages, access } = create();
    pages.findById.mockResolvedValue({ id: 'page', isBase: false, deletedAt: null });
    await expect(service.get('page', user)).rejects.toBeInstanceOf(NotFoundException);
    expect(access.validateCanView).toHaveBeenCalled();
  });

  it('rejects unsupported property types before persistence', async () => {
    const { service, pages } = create();
    pages.findById.mockResolvedValue({ id: 'page', isBase: true, deletedAt: null });
    await expect(service.addProperty('page', user, { name: 'Cost', type: 'unsupported' as any }, 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an out-of-date property update before writing', async () => {
    const { service, pages } = create();
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', spaceId: 'space', isBase: true, deletedAt: null, baseSchemaVersion: 2 });
    await expect(service.addProperty('page', user, { name: 'Cost', type: 'number' }, 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an out-of-date row update before writing', async () => {
    const { service, pages } = create();
    pages.findById.mockResolvedValue({ id: 'page', isBase: true, deletedAt: null, baseSchemaVersion: 2 });
    await expect(service.updateRow('page', 'row', user, { cells: {}, version: 1 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses a conditional schema update inside a transaction for row writes', async () => {
    const { service, pages } = create();
    pages.findById.mockResolvedValue({ id: 'page', isBase: true, deletedAt: null, baseSchemaVersion: 1 });
    const executeTakeFirst = jest.fn().mockResolvedValue(undefined);
    const trx = {
      updateTable: jest.fn(() => ({
        set: () => ({
          where: () => ({
            where: () => ({ returning: () => ({ executeTakeFirst }) }),
          }),
        }),
      })),
    };
    (service as any).db.transaction = () => ({ execute: (fn: any) => fn(trx) });
    await expect(service.updateRow('page', 'row', user, { version: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect(trx.updateTable).toHaveBeenCalledWith('pages');
  });


  it('rolls back a property or view version bump when its transactional write fails', async () => {
    const { service } = create();
    const write = jest.fn().mockRejectedValue(new Error('write failed'));
    const executeTakeFirst = jest.fn().mockResolvedValue({ baseSchemaVersion: 2 });
    const transaction = { updateTable: jest.fn(() => ({ set: () => ({ where: () => ({ where: () => ({ returning: () => ({ executeTakeFirst }) }) }) }) })) };
    (service as any).db.transaction = () => ({ execute: (work: any) => work(transaction) });

    await expect((service as any).mutate({ id: 'page', workspaceId: 'workspace', spaceId: 'space', baseSchemaVersion: 1 }, user, 1, write)).rejects.toThrow('write failed');
    expect(write).toHaveBeenCalledWith(transaction);
  });

  it('does not run a property or view write after a concurrent version change', async () => {
    const { service } = create();
    const write = jest.fn();
    const executeTakeFirst = jest.fn().mockResolvedValue(undefined);
    const transaction = {
      updateTable: jest.fn(() => ({
        set: () => ({
          where: () => ({
            where: () => ({ returning: () => ({ executeTakeFirst }) }),
          }),
        }),
      })),
    };
    (service as any).db.transaction = () => ({ execute: (work: any) => work(transaction) });

    await expect((service as any).mutate({ id: 'page', workspaceId: 'workspace', spaceId: 'space', baseSchemaVersion: 1 }, user, 1, write)).rejects.toBeInstanceOf(ConflictException);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not conceal page-access infrastructure failures as read-only', async () => {
    const { service } = create();
    const error = new Error('access database unavailable');
    jest.spyOn((service as any).pageAccess, 'validateCanEdit').mockRejectedValue(error);
    await expect((service as any).permissions({ id: 'page' }, user)).rejects.toBe(error);
  });

  it('reports a genuine edit denial as read-only', async () => {
    const { service } = create();
    jest.spyOn((service as any).pageAccess, 'validateCanEdit').mockRejectedValue(new ForbiddenException());
    await expect((service as any).permissions({ id: 'page' }, user)).resolves.toEqual({ canEdit: false });
  });

  it('creates the base page and default schema in one transaction', async () => {
    const { service, pages } = create();
    const trx: any = {
      insertInto: jest.fn(() => ({ values: () => ({ execute: jest.fn() }) })),
    };
    pages.findById.mockResolvedValue({ id: 'parent', workspaceId: 'workspace', spaceId: 'space', deletedAt: null });
    (service as any).pageService.create = jest.fn().mockResolvedValue({ id: 'base', workspaceId: 'workspace' });
    (service as any).db.transaction = () => ({ execute: (work: any) => work(trx) });

    await service.create('parent', user);

    expect((service as any).pageService.create).toHaveBeenCalledWith(user.id, 'workspace', expect.objectContaining({ parentPageId: 'parent', spaceId: 'space' }), trx, true);
    expect(trx.insertInto).toHaveBeenCalledWith('baseProperties');
    expect(trx.insertInto).toHaveBeenCalledWith('baseViews');
  });

  it('converts the page and seeds its schema in one transaction', async () => {
    const { service, pages } = create();
    const executeTakeFirst = jest.fn().mockResolvedValue({ id: 'page' });
    const trx: any = {
      updateTable: jest.fn(() => ({
        set: () => ({
          where: () => ({
            where: () => ({ returning: () => ({ executeTakeFirst }) }),
          }),
        }),
      })),
      insertInto: jest.fn(() => ({ values: () => ({ execute: jest.fn() }) })),
    };
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', isBase: false, deletedAt: null });
    jest.spyOn(service, 'get').mockResolvedValue({} as any);
    (service as any).db.transaction = () => ({ execute: (work: any) => work(trx) });

    await service.convert('page', user);

    expect(trx.updateTable).toHaveBeenCalledWith('pages');
    expect(trx.insertInto).toHaveBeenCalledWith('baseProperties');
    expect(trx.insertInto).toHaveBeenCalledWith('baseViews');
  });
});

describe('Base row mutations', () => {
  const user: any = { id: 'user', workspaceId: 'workspace' };

  function create() {
    const db: any = {};
    const pages: any = { findById: jest.fn() };
    const access: any = { validateCanEdit: jest.fn(), validateCanView: jest.fn() };
    return {
      service: new BaseService(
        db,
        pages,
        {} as any,
        access,
        { logWithContextInTransaction: jest.fn() } as any,
      ),
      pages,
    };
  }

  it('rejects stale add, delete, and CSV versions before transactional payload writes', async () => {
    const { service, pages } = create();
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', isBase: true, deletedAt: null, baseSchemaVersion: 2 });
    jest.spyOn(service as any, 'validateCells').mockResolvedValue(undefined);

    await expect(service.addRow('page', user, {}, 1)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.removeRow('page', 'row', user, 1)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.importCsv('page', user, 'Name\nvalue', 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('routes add, delete, and CSV payload writes through the version transaction', async () => {
    const { service, pages } = create();
    const mutate = jest.spyOn(service as any, 'mutate').mockResolvedValue({ id: 'row' });
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', isBase: true, deletedAt: null, baseSchemaVersion: 1 });
    jest.spyOn(service as any, 'validateCells').mockResolvedValue(undefined);

    await service.addRow('page', user, {}, 1);
    await service.removeRow('page', 'row', user, 1);
    await service.importCsv('page', user, 'Name\nvalue', 1);

    expect(mutate).toHaveBeenCalledTimes(3);
    expect(mutate.mock.calls.map(([, , version]) => version)).toEqual([1, 1, 1]);
  });

  it('propagates an add-row payload write failure after the conditional version update', async () => {
    const { service, pages } = create();
    const write = jest.fn().mockRejectedValue(new Error('row write failed'));
    const lastRow = { executeTakeFirst: jest.fn().mockResolvedValue(undefined) };
    const transaction = {
      updateTable: jest.fn(() => ({
        set: () => ({
          where: () => ({
            where: () => ({
              returning: () => ({
                executeTakeFirst: jest
                  .fn()
                  .mockResolvedValue({ baseSchemaVersion: 2 }),
              }),
            }),
          }),
        }),
      })),
      selectFrom: jest.fn(() => ({ select: () => ({ where: () => ({ orderBy: () => lastRow }) }) })),
      insertInto: jest.fn(() => ({ values: () => ({ returningAll: () => ({ executeTakeFirst: write }) }) })),
    };
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', isBase: true, deletedAt: null, baseSchemaVersion: 1 });
    jest.spyOn(service as any, 'validateCells').mockResolvedValue(undefined);
    (service as any).db.transaction = () => ({ execute: (work: any) => work(transaction) });

    await expect(service.addRow('page', user, {}, 1)).rejects.toThrow('row write failed');
    expect(transaction.updateTable).toHaveBeenCalledWith('pages');
    expect(transaction.insertInto).toHaveBeenCalledWith('baseRows');
  });
});


describe('Base view mutations', () => {
  const user: any = { id: 'user', workspaceId: 'workspace' };

  function create() {
    const db: any = {};
    const pages: any = { findById: jest.fn() };
    const access: any = { validateCanEdit: jest.fn(), validateCanView: jest.fn() };
    return {
      service: new BaseService(
        db,
        pages,
        {} as any,
        access,
        { logWithContextInTransaction: jest.fn() } as any,
      ),
      pages,
    };
  }

  it('rejects a stale view creation before a view write', async () => {
    const { service, pages } = create();
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', isBase: true, deletedAt: null, baseSchemaVersion: 2 });

    await expect(service.saveView('page', user, { name: 'Table' }, 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('routes a new view through the schema version transaction', async () => {
    const { service, pages } = create();
    const mutate = jest.spyOn(service as any, 'mutate').mockResolvedValue({ id: 'view' });
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', isBase: true, deletedAt: null, baseSchemaVersion: 1 });

    await service.saveView('page', user, { name: 'Table' }, 1);

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'page' }),
      user,
      1,
      expect.any(Function),
    );
  });

  it('does not create a view after a concurrent schema version change', async () => {
    const { service, pages } = create();
    const write = jest.fn();
    const trx = {
      updateTable: jest.fn(() => ({
        set: () => ({
          where: () => ({
            where: () => ({
              returning: () => ({
                executeTakeFirst: jest.fn().mockResolvedValue(undefined),
              }),
            }),
          }),
        }),
      })),
      selectFrom: jest.fn(() => ({ select: () => ({ where: () => ({ orderBy: () => ({ executeTakeFirst: jest.fn() }) }) }) })),
      insertInto: jest.fn(() => ({ values: write })),
    };
    pages.findById.mockResolvedValue({ id: 'page', workspaceId: 'workspace', isBase: true, deletedAt: null, baseSchemaVersion: 1 });
    (service as any).db.transaction = () => ({ execute: (work: any) => work(trx) });

    await expect(service.saveView('page', user, { name: 'Table' }, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(write).not.toHaveBeenCalled();
  });
});
