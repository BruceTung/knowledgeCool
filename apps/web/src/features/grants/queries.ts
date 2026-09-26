/**
 * 节点授权的查询与变更(DESIGN.md §5.3 规则三 / §6.2)。
 *
 * ⚠️ 一个节点上"谁能改"由**三段**组成,并且只有第三段可编辑:
 *   1. 所有者 —— 不可改(改所有者是另一个操作:`PATCH /nodes/:id/owner`)
 *   2. 祖先链上的所有者 —— 不可改(他们在链上,这是模型本身决定的)
 *   3. 显式授权名单 —— 这一段可增删
 *
 * UI 必须把这三段**分开显示**,否则管理员会试图去"移除"组长,
 * 点半天发现删不掉。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GrantCandidate,
  NodeGrantsResponse,
  SaveNodeGrantsInput,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function useNodeGrants(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'grants'],
    queryFn: () => apiFetch<NodeGrantsResponse>(`/nodes/${String(nodeId)}/grants`),
    enabled: nodeId !== undefined && nodeId !== '',
  });
}

export function useGrantCandidates(nodeId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'grant-candidates'],
    queryFn: () => apiFetch<GrantCandidate[]>(`/nodes/${String(nodeId)}/grant-candidates`),
    enabled: enabled && nodeId !== undefined && nodeId !== '',
  });
}

export function useSaveGrants(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveNodeGrantsInput) =>
      apiSend<NodeGrantsResponse>('PUT', `/nodes/${nodeId}/grants`, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(['node', nodeId, 'grants'], saved);
      // 授权变了 → 树上的按钮该跟着变(服务端算的 editableNodeIds)
      void queryClient.invalidateQueries({ queryKey: ['org', 'tree'] });
    },
  });
}
