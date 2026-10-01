/**
 * 节点评论的服务端状态(DESIGN.md §5.4)。
 *
 * ⚠️ v2.0 起**全员都能评论**(读是开放的,评论跟着读走)。
 *
 * 权限只区分两件事,而且它们**不是同一件事**:
 *   - 改正文:只有作者本人(所有者也不行 —— 那是篡改他人言论)
 *   - 删除:作者本人,或该节点的任一祖先所有者(版务清理)
 *
 * 服务端返回的 `canEdit` / `canDelete` 只用于显示按钮,判定仍在服务端。
 *
 * ⚠️ 这里**没有"已解决"**。评论不是问题单(2026-09-27 用户明确纠正),
 * 那套状态已整体移除。
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
    // 树上的角标跟着变。角标是服务端算的(commentCount),本地推不出来。
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
    mutationFn: (vars: { commentId: string; body: string }) =>
      apiSend<CommentView>('PATCH', `/comments/${vars.commentId}`, {
        body: vars.body,
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
