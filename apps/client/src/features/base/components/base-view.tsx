import { Button, Card, Group, Select, SimpleGrid, Table, Text, TextInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { socketAtom } from '@/features/websocket/atoms/socket-atom';
import { addBaseProperty, addBaseRow, saveBaseRow, saveBaseView } from '../services/base-service';
import { useBaseQuery } from '../queries/base-query';
import { BaseRow } from '../services/base-service';
import { BaseTableSkeleton } from './base-table-skeleton';

export function BaseView({ pageId, editable = false, embedded = false, titleSlot }: { pageId: string; editable?: boolean; embedded?: boolean; titleSlot?: React.ReactNode }) {
  const query = useBaseQuery(pageId);
  const cache = useQueryClient();
  const socket = useAtomValue(socketAtom);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<string>();
  const [sorts, setSorts] = useState<Array<{ propertyId: string; direction: 'asc' | 'desc' }>>([]);
  const [view, setView] = useState<'table' | 'kanban'>('table');
  const base = query.data;
  const rows = useMemo(() => (base?.rows ?? []).filter((row) => Object.values(row.cells).join(' ').toLowerCase().includes(filter.toLowerCase())).sort((left, right) => sort ? String(left.cells[sort] ?? '').localeCompare(String(right.cells[sort] ?? '')) : 0), [base?.rows, filter, sort]);
  const refresh = () => cache.invalidateQueries({ queryKey: ['base', pageId] });
  const announce = () => socket?.emit('message', { type: 'base:changed', pageId, version: base?.page.baseSchemaVersion ?? 0 });
  useEffect(() => {
    const changed = (event: { pageId: string }) => { if (event.pageId === pageId) refresh(); };
    socket?.on('base:changed', changed);
    return () => { socket?.off('base:changed', changed); };
  }, [pageId, socket]);
  if (query.isLoading) return <BaseTableSkeleton />;
  if (!base) return null;
  const canEdit = editable && base.permissions.canEdit;
  const group = base.properties.find((property) => property.type === 'select' || property.type === 'multiSelect');
  const groups = group ? groupRows(rows, group.id) : new Map([['Rows', rows]]);
  const cell = (row: BaseRow, propertyId: string) => String(row.cells[propertyId] ?? '');
  const edit = (row: BaseRow, propertyId: string, value: string) => saveBaseRow(pageId, row.id, { ...row.cells, [propertyId]: value }, base.page.baseSchemaVersion).then(() => { refresh(); announce(); });
  const selectSort = (propertyId: string) => { const next = [...sorts.filter((rule) => rule.propertyId !== propertyId), { propertyId, direction: 'asc' as const }].slice(-5); setSort(propertyId); setSorts(next); const active = base.views[0]; if (active) saveBaseView(pageId, active.id, active.name, active.type, { ...active.config, sorts: next }, base.page.baseSchemaVersion).then(refresh); };
  return <div data-base-embed={embedded || undefined}>{titleSlot}<Group justify="space-between" mb="sm"><Group><TextInput aria-label="Filter rows" placeholder="Filter rows" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} /><Select aria-label="Base view" value={view} onChange={(value) => setView(value === 'kanban' ? 'kanban' : 'table')} data={[{ value: 'table', label: 'Table' }, { value: 'kanban', label: 'Kanban' }]} /></Group><Group>{canEdit && <Button size="xs" onClick={() => addBaseProperty(pageId, `Property ${base.properties.length + 1}`, base.page.baseSchemaVersion).then(() => { refresh(); announce(); })}>Add property</Button>}{canEdit && <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => addBaseRow(pageId, {}, base.page.baseSchemaVersion).then(() => { refresh(); announce(); })}>Add row</Button>}</Group></Group>{view === 'kanban' ? <SimpleGrid cols={{ base: 1, md: Math.min(groups.size, 4) }}>{Array.from(groups).map(([name, items]) => <Card key={name} withBorder><Text fw={600} mb="xs">{name}</Text>{items.map((row) => <Card key={row.id} withBorder mb="xs">{base.properties.filter((property) => property.id !== group?.id).map((property) => <Text key={property.id} size="sm">{property.name}: {cell(row, property.id)}</Text>)}</Card>)}</Card>)}</SimpleGrid> : <Table striped withTableBorder><Table.Thead><Table.Tr>{base.properties.map((property) => <Table.Th key={property.id}><button type="button" onClick={() => selectSort(property.id)}>{property.name}</button></Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{rows.map((row) => <Table.Tr key={row.id}>{base.properties.map((property) => <Table.Td key={property.id}>{canEdit && property.type !== 'formula' ? <TextInput variant="unstyled" defaultValue={cell(row, property.id)} onBlur={(event) => edit(row, property.id, event.currentTarget.value)} /> : cell(row, property.id)}</Table.Td>)}</Table.Tr>)}</Table.Tbody></Table>}</div>;
}

export function groupRows(rows: BaseRow[], propertyId: string): Map<string, BaseRow[]> {
  return rows.reduce((groups, row) => { const name = String(row.cells[propertyId] ?? 'Unassigned'); groups.set(name, [...(groups.get(name) ?? []), row]); return groups; }, new Map<string, BaseRow[]>());
}
