/**
 * 可见性与读者名单的查询与变更(DESIGN.md §5.6 / §6.2)。
 *
 * ⚠️ 与授权的查询刻意**分文件、分缓存键**。用户的要求是「创建者单独授权,不复用」,
 * 那条要求不止落在数据库上,也落在这里:两条路径的缓存键混在一起的话,
 * 改一处会让另一处无谓失效,而且排查"为什么按钮灰了"时要同时看两份数据。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  NodeReadersResponse,
  ReaderCandidate,
  SaveNodeReadersInput,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function useNodeReaders(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'readers'],
    queryFn: () => apiFetch<NodeReadersResponse>(`/nodes/${String(nodeId)}/readers`),
    enabled: nodeId !== undefined && nodeId !== '',
  });
}

export function useReaderCandidates(nodeId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'reader-candidates'],
    queryFn: () => apiFetch<ReaderCandidate[]>(`/nodes/${String(nodeId)}/reader-candidates`),
    enabled: enabled && nodeId !== undefined && nodeId !== '',
  });
}

export function useSaveReaders(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveNodeReadersInput) =>
      apiSend<NodeReadersResponse>('PUT', `/nodes/${nodeId}/readers`, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(['node', nodeId, 'readers'], saved);
      // 可见性变了 → 树上那个锁形图标、以及"我还能不能看到它"都可能变
      void queryClient.invalidateQueries({ queryKey: ['org', 'tree'] });
      void queryClient.invalidateQueries({ queryKey: ['node', nodeId] });
      // 正文与评论也可能从"读得到"变成"读不到"
      void queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'content'] });
      void queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'comments'] });
    },
  });
}
