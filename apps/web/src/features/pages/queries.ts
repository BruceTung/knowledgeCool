/**
 * 页面树的服务端状态(DESIGN.md §7.3)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePageInput,
  MovePageInput,
  PageDetail,
  PageTreeResponse,
  TrashItem,
  UpdatePageInput,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function usePageTree(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'pages'],
    queryFn: () => apiFetch<PageTreeResponse>(`/spaces/${String(spaceId)}/pages`),
    enabled: spaceId !== undefined && spaceId !== '',
  });
}

export function usePageDetail(pageId: string | undefined) {
  return useQuery({
    queryKey: ['pages', pageId],
    queryFn: () => apiFetch<PageDetail>(`/pages/${String(pageId)}`),
    enabled: pageId !== undefined && pageId !== '',
  });
}

export function useTrash(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'trash'],
    queryFn: () => apiFetch<TrashItem[]>(`/spaces/${String(spaceId)}/trash`),
    enabled: spaceId !== undefined && spaceId !== '',
  });
}

/** 任何改动都可能影响树、回收站与单页详情,统一失效。 */
function useInvalidatePages(spaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['spaces', spaceId, 'pages'] });
    void queryClient.invalidateQueries({ queryKey: ['spaces', spaceId, 'trash'] });
    void queryClient.invalidateQueries({ queryKey: ['pages'] });
  };
}

export function useCreatePage(spaceId: string) {
  const invalidate = useInvalidatePages(spaceId);
  return useMutation({
    mutationFn: (input: { parentId: string | null; title?: string }) =>
      apiSend<PageDetail>('POST', '/pages', { spaceId, ...input } satisfies CreatePageInput),
    onSuccess: invalidate,
  });
}

export function useUpdatePage(spaceId: string) {
  const invalidate = useInvalidatePages(spaceId);
  return useMutation({
    mutationFn: (vars: { pageId: string } & UpdatePageInput) =>
      apiSend<PageDetail>(
        'PATCH',
        `/pages/${vars.pageId}`,
        {
          version: vars.version,
          ...(vars.title === undefined ? {} : { title: vars.title }),
          ...(vars.status === undefined ? {} : { status: vars.status }),
        } satisfies UpdatePageInput,
      ),
    onSuccess: invalidate,
  });
}

export function useMovePage(spaceId: string) {
  const invalidate = useInvalidatePages(spaceId);
  return useMutation({
    mutationFn: (vars: { pageId: string } & MovePageInput) =>
      apiSend<PageDetail>(
        'POST',
        `/pages/${vars.pageId}/move`,
        {
          newParentId: vars.newParentId,
          version: vars.version,
          ...(vars.newPosition === undefined ? {} : { newPosition: vars.newPosition }),
        } satisfies MovePageInput,
      ),
    onSuccess: invalidate,
  });
}

export function useDeletePage(spaceId: string) {
  const invalidate = useInvalidatePages(spaceId);
  return useMutation({
    mutationFn: (pageId: string) =>
      apiSend<{ removedCount: number }>('DELETE', `/pages/${pageId}`),
    onSuccess: invalidate,
  });
}

export function useRestorePage(spaceId: string) {
  const invalidate = useInvalidatePages(spaceId);
  return useMutation({
    mutationFn: (pageId: string) => apiSend<PageDetail>('POST', `/pages/${pageId}/restore`),
    onSuccess: invalidate,
  });
}

export function usePurgePage(spaceId: string) {
  const invalidate = useInvalidatePages(spaceId);
  return useMutation({
    mutationFn: (pageId: string) => apiSend<void>('DELETE', `/pages/${pageId}/purge`),
    onSuccess: invalidate,
  });
}
