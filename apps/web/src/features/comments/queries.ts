/**
 * 页面评论的服务端状态(DESIGN.md §8.4)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommentListResponse,
  CommentView,
  CreateCommentInput,
  UpdateCommentInput,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function useComments(pageId: string | undefined) {
  return useQuery({
    queryKey: ['pages', pageId, 'comments'],
    queryFn: () => apiFetch<CommentListResponse>(`/pages/${String(pageId)}/comments`),
    enabled: pageId !== undefined && pageId !== '',
  });
}

/** 空间内各页面的未解决评论数 —— 页面树角标。 */
export function useCommentCounts(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'comment-counts'],
    queryFn: () => apiFetch<Record<string, number>>(`/spaces/${String(spaceId)}/comment-counts`),
    enabled: spaceId !== undefined && spaceId !== '',
    // 角标不需要秒级准确,少发点请求
    staleTime: 30_000,
  });
}

function useInvalidateComments(spaceId: string | undefined, pageId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['pages', pageId, 'comments'] });
    // 页面树角标跟着变
    if (spaceId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: ['spaces', spaceId, 'comment-counts'] });
    }
  };
}

export function useCreateComment(spaceId: string | undefined, pageId: string) {
  const invalidate = useInvalidateComments(spaceId, pageId);
  return useMutation({
    mutationFn: (input: CreateCommentInput) =>
      apiSend<CommentView>('POST', `/pages/${pageId}/comments`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateComment(spaceId: string | undefined, pageId: string) {
  const invalidate = useInvalidateComments(spaceId, pageId);
  return useMutation({
    mutationFn: (vars: { commentId: string } & UpdateCommentInput) =>
      apiSend<CommentView>('PATCH', `/comments/${vars.commentId}`, {
        ...(vars.body === undefined ? {} : { body: vars.body }),
        ...(vars.status === undefined ? {} : { status: vars.status }),
      } satisfies UpdateCommentInput),
    onSuccess: invalidate,
  });
}

export function useDeleteComment(spaceId: string | undefined, pageId: string) {
  const invalidate = useInvalidateComments(spaceId, pageId);
  return useMutation({
    mutationFn: (commentId: string) => apiSend<void>('DELETE', `/comments/${commentId}`),
    onSuccess: invalidate,
  });
}
