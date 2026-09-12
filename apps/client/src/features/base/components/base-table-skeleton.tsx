import { Skeleton, Stack } from '@mantine/core';
export function BaseTableSkeleton({ rows = 3, columns = 3 }: { rows?: number; columns?: number }) { return <Stack gap="xs">{Array.from({ length: rows }).map((_, row) => <Skeleton key={row} height={24} width={`${Math.max(30, columns * 25)}%`} />)}</Stack>; }
