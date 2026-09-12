import api from '@/lib/api-client';
export type BaseProperty = { id: string; name: string; type: string; position: string; typeOptions?: { formula?: string } };
export type BaseRow = { id: string; cells: Record<string, unknown>; position: string };
export type BaseData = { page: { id: string; baseSchemaVersion: number }; properties: BaseProperty[]; rows: BaseRow[]; views: Array<{ id: string; name: string; type: string; config: Record<string, unknown> }>; permissions: { canEdit: boolean } };
export async function getBase(pageId: string) { return (await api.post<BaseData>('/bases/info', { pageId })).data; }
export async function addBaseRow(pageId: string, cells: BaseRow['cells'], version: number) { return (await api.post('/bases/rows/create', { pageId, cells, version })).data; }
export async function saveBaseRow(pageId: string, rowId: string, cells: BaseRow['cells'], version: number) { return (await api.post('/bases/rows/update', { pageId, rowId, cells, version })).data; }
export async function addBaseProperty(pageId: string, name: string, version: number, type = 'text', formula?: string) { return (await api.post('/bases/properties/create', { pageId, name, version, type, formula })).data; }
export async function convertToBase(pageId: string) { return (await api.post('/bases/convert', { pageId })).data; }
export async function saveBaseView(pageId: string, id: string | undefined, name: string, type: string, config: Record<string, unknown>, version: number) { return (await api.post('/bases/views/save', { pageId, id, name, type, config, version })).data; }
