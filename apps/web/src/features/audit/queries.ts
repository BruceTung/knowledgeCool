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

export function useAuditLogs(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['audit-logs'],
    queryFn: ({ pageParam }) =>
      apiFetch<AuditLogPage>(
        `/audit-logs?limit=50${pageParam === null ? '' : `&cursor=${String(pageParam)}`}`,
      ),
    initialPageParam: null as string | null,
    // 游标分页:下一页的游标就是上一页最后一条的 id
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
  });
}
