/**
 * 节点成员的查询与变更(v2.4,DESIGN.md §8.4「调岗两步」的配套)。
 *
 * 缓存键:`['node', id, 'members']` —— 与 `grants` / `content` 同一命名法。
 *
 * ⚠️ 归属变更之后必须**同时**刷新树:组织范围变了,服务端算出来的
 * `editableNodeIds` / `manageableNodeIds` 跟着变。只刷 `members`
 * 会让"我刚把他加进来,但树上还是老样子"。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddNodeMemberInput,
  GrantCandidate,
  NodeMembersResponse,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function useNodeMembers(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'members'],
    queryFn: () => apiFetch<NodeMembersResponse>(`/nodes/${String(nodeId)}/members`),
    enabled: nodeId !== undefined && nodeId !== '',
  });
}

/** 可加入的人 —— 服务端已按组织范围过滤,前端不再自己算。 */
export function useMemberCandidates(nodeId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'member-candidates'],
    queryFn: () => apiFetch<GrantCandidate[]>(`/nodes/${String(nodeId)}/member-candidates`),
    enabled: enabled && nodeId !== undefined && nodeId !== '',
  });
}

function useInvalidateMembers(nodeId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'members'] });
    // 归属一变,树上的权限标记与候选人列表都可能变
    void queryClient.invalidateQueries({ queryKey: ['org'] });
    void queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'grant-candidates'] });
    void queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'member-candidates'] });
  };
}

export function useAddNodeMember(nodeId: string) {
  const invalidate = useInvalidateMembers(nodeId);
  return useMutation({
    mutationFn: (input: AddNodeMemberInput) =>
      apiSend<NodeMembersResponse>('POST', `/nodes/${nodeId}/members`, input),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useRemoveNodeMember(nodeId: string) {
  const invalidate = useInvalidateMembers(nodeId);
  return useMutation({
    mutationFn: (userId: string) =>
      apiSend<NodeMembersResponse>('DELETE', `/nodes/${nodeId}/members/${userId}`),
    onSuccess: () => {
      invalidate();
    },
  });
}
