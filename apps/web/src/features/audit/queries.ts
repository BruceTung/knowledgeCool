/**
 * 审计日志的服务端状态(DESIGN.md §6.2)。
 *
 * ⚠️ v2.0 去掉了 `spaceId` 参数:可见范围现在由**我拥有哪些节点**决定,
 * 不由"我选了哪个空间"决定。传范围参数反而会绕开那条规则,
 * 所以服务端也不接受它。
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditLogPage } from '@knowledgecool/shared';

import { apiFetch } from '../../lib/api';

/**
 * @param action 按动作筛选。**筛选键必须进 queryKey** ——
 *   否则切换筛选条件时会命中上一次的缓存,用户看到的是"选了 A 却显示 B 的结果"。
 */
export function useAuditLogs(enabled: boolean, action = '') {
  return useInfiniteQuery({
    queryKey: ['audit-logs', action],
    queryFn: ({ pageParam }) =>
      apiFetch<AuditLogPage>(
        `/audit-logs?limit=50${action === '' ? '' : `&action=${encodeURIComponent(action)}`}` +
          (pageParam === null ? '' : `&cursor=${String(pageParam)}`),
      ),
    initialPageParam: null as string | null,
    // 游标分页:下一页的游标就是上一页最后一条的 id
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
  });
}
