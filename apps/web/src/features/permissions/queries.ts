/**
 * 页面权限的服务端状态(DESIGN.md §5)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PagePermissionsResponse,
  PermissionSubjectCandidate,
  SavePagePermissionsInput,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function usePagePermissions(pageId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['pages', pageId, 'permissions'],
    queryFn: () => apiFetch<PagePermissionsResponse>(`/pages/${String(pageId)}/permissions`),
    enabled: enabled && pageId !== undefined && pageId !== '',
  });
}

export function usePermissionCandidates(spaceId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'permission-candidates'],
    queryFn: () =>
      apiFetch<PermissionSubjectCandidate[]>(`/spaces/${String(spaceId)}/permission-candidates`),
    enabled: enabled && spaceId !== undefined && spaceId !== '',
    staleTime: 60_000,
  });
}

export function useSavePermissions(pageId: string, spaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SavePagePermissionsInput) =>
      apiSend<PagePermissionsResponse>('PUT', `/pages/${pageId}/permissions`, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(['pages', pageId, 'permissions'], saved);
      // 权限一改,页面树与检索结果的可见范围都可能变 —— 必须整片失效。
      // 服务端已经把该空间的权限缓存世代号 +1 了,这里让前端跟着重算。
      void queryClient.invalidateQueries({ queryKey: ['spaces', spaceId, 'pages'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      void queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
    },
  });
}
