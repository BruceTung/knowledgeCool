/**
 * 正文与导出的服务端状态(DESIGN.md §7.4)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageContentResponse, SaveContentInput } from '@knowledgecool/shared';

import { apiDownload, apiFetch, apiSend, apiUpload } from '../../lib/api';

export function usePageContent(pageId: string | undefined) {
  return useQuery({
    queryKey: ['pages', pageId, 'content'],
    queryFn: () => apiFetch<PageContentResponse>(`/pages/${String(pageId)}/content`),
    enabled: pageId !== undefined && pageId !== '',
    // 正文的冲突检测靠自己带回 baseUpdatedAt,不需要 react-query 的重新拉取
    // 来"顺手改掉"编辑器里的内容 —— 那种自动刷新会把正在打字的人搞疯。
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function useSaveContent(pageId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveContentInput) =>
      apiSend<PageContentResponse>('PUT', `/pages/${pageId}/content`, input),
    onSuccess: (saved) => {
      // 只更新缓存里的时间戳,不 invalidate ——
      // invalidate 会触发重新拉取,把编辑器里的内容重置一遍。
      queryClient.setQueryData<PageContentResponse>(['pages', pageId, 'content'], saved);
      // 正文变了,检索结果就旧了
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      // 页面详情上的 updatedAt 也该跟着变
      void queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
    },
  });
}

/** 上传图片,返回可直接当 `src` 用的 URL。 */
export function useImageUpload() {
  return useMutation({
    mutationFn: (file: File) => apiUpload<{ url: string }>('/uploads', file),
  });
}

/** 导出为 Markdown 并触发下载。 */
export function useExportMarkdown() {
  return useMutation({
    mutationFn: (vars: { pageId: string; title: string }) =>
      apiDownload(`/pages/${vars.pageId}/export?format=md`, `${vars.title || 'page'}.md`),
  });
}
