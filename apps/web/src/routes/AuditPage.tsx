import { AUDIT_ACTION_LABELS, can } from '@knowledgecool/shared';
import { useParams } from 'react-router-dom';

import { ErrorNote } from '../components/ui';
import { useAuditLogs } from '../features/audit/queries';
import { usePageTree } from '../features/pages/queries';

/**
 * 审计日志(DESIGN.md §6.2 的 `GET /audit-logs`)。
 *
 * 授权在服务端:有该空间的 `audit.view`(admin 起)才能看到该空间的记录;
 * 跨空间只给超管。前端在这里只负责"别让没有权限的人看到一个空表格"。
 */
export function AuditPage() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const tree = usePageTree(spaceId);
  const allowed = can(tree.data?.role ?? 'viewer', 'audit.view');
  const logs = useAuditLogs(spaceId, allowed && spaceId !== undefined);

  if (!allowed) {
    return (
      <div className="p-8">
        <p className="text-sm text-slate-500">查看审计日志需要空间管理员权限。</p>
      </div>
    );
  }

  const items = logs.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-lg font-semibold text-slate-900">审计日志</h1>
      <p className="mt-1 text-xs text-slate-500">
        只写不删。登录、页面变更、权限变更、评论都会留痕 —— 事后追责靠的就是这一页。
      </p>

      {logs.isError && (
        <div className="mt-4">
          <ErrorNote error={logs.error} />
        </div>
      )}

      {logs.isPending && <p className="mt-6 text-sm text-slate-400">加载中…</p>}

      {!logs.isPending && items.length === 0 && (
        <p className="mt-6 text-sm text-slate-400">还没有审计记录。</p>
      )}

      {items.length > 0 && (
        <>
          <table className="mt-4 w-full text-left text-xs">
            <thead className="text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-2 font-normal">时间</th>
                <th className="py-2 font-normal">操作者</th>
                <th className="py-2 font-normal">动作</th>
                <th className="py-2 font-normal">目标</th>
                <th className="py-2 font-normal">来源 IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-slate-100">
                  <td className="whitespace-nowrap py-2 text-slate-500">
                    {new Date(item.createdAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="py-2 text-slate-700">{item.actor?.name ?? '(系统)'}</td>
                  <td className="py-2 text-slate-700">
                    {AUDIT_ACTION_LABELS[item.action] ?? item.action}
                  </td>
                  <td className="max-w-[240px] truncate py-2 text-slate-500" title={item.targetId}>
                    {item.targetLabel ?? `${item.targetType}:${item.targetId}`}
                  </td>
                  <td className="py-2 text-slate-400">{item.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {logs.hasNextPage && (
            <button
              type="button"
              disabled={logs.isFetchingNextPage}
              onClick={() => {
                void logs.fetchNextPage();
              }}
              className="mt-4 rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              {logs.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
