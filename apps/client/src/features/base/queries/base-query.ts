import { useQuery } from '@tanstack/react-query';
import { getBase } from '../services/base-service';
export function useBaseQuery(pageId: string) { return useQuery({ queryKey: ['base', pageId], queryFn: () => getBase(pageId), enabled: Boolean(pageId) }); }
