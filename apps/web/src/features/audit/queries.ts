/**
 * 审计日志的服务端状态(DESIGN.md §6.2)。
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditLogPage } from '@knowledgecool/shared';

import { apiFetch } from '../../lib/api';

export function useAuditLogs(spaceId: string | undefined, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['audit-logs', spaceId ?? ''],
    queryFn: ({ pageParam }) =>
      apiFetch<AuditLogPage>(
        `/audit-logs?${spaceId === undefined ? '' : `spaceId=${spaceId}&`}limit=50${
          pageParam === null ? '' : `&cursor=${String(pageParam)}`
        }`,
      ),
    initialPageParam: null as string | null,
    // 游标分页:下一页的游标就是上一页最后一条的 id
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
  });
}
