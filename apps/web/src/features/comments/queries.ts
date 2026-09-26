/**
 * 节点评论的服务端状态(DESIGN.md §8.4)。
 *
 * ⚠️ v2.0 起**全员都能评论**(读是开放的,评论跟着读走)。
 * 权限只区分两件事:改**别人的**评论不行;标为已解决要作者本人或该节点的
 * 祖先所有者。两者都由服务端判定,这里拿到的 `canResolve` / `canDelete`
 * 只用于显示按钮。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommentListResponse,
  CommentView,
  CreateCommentInput,
  UpdateCommentInput,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function useComments(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'comments'],
    queryFn: () => apiFetch<CommentListResponse>(`/nodes/${String(nodeId)}/comments`),
    enabled: nodeId !== undefined && nodeId !== '',
  });
}

function useInvalidateComments(nodeId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['node', nodeId, 'comments'] });
    // 树上的角标跟着变。角标是服务端算的(openCommentCount),本地推不出来。
    void queryClient.invalidateQueries({ queryKey: ['org', 'tree'] });
  };
}

export function useCreateComment(nodeId: string) {
  const invalidate = useInvalidateComments(nodeId);
  return useMutation({
    mutationFn: (input: CreateCommentInput) =>
      apiSend<CommentView>('POST', `/nodes/${nodeId}/comments`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateComment(nodeId: string) {
  const invalidate = useInvalidateComments(nodeId);
  return useMutation({
    mutationFn: (vars: { commentId: string } & UpdateCommentInput) =>
      apiSend<CommentView>('PATCH', `/comments/${vars.commentId}`, {
        ...(vars.body === undefined ? {} : { body: vars.body }),
        ...(vars.status === undefined ? {} : { status: vars.status }),
      } satisfies UpdateCommentInput),
    onSuccess: invalidate,
  });
}

export function useDeleteComment(nodeId: string) {
  const invalidate = useInvalidateComments(nodeId);
  return useMutation({
    mutationFn: (commentId: string) => apiSend<void>('DELETE', `/comments/${commentId}`),
    onSuccess: invalidate,
  });
}
