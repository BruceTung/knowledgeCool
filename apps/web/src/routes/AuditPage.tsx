import { AUDIT_ACTION_LABELS } from '@knowledgecool/shared';

import { ErrorNote } from '../components/ui';
import { useAuditLogs } from '../features/audit/queries';

/**
 * 审计日志(DESIGN.md §6.2 的 `GET /audit-logs`)。
 *
 * ⚠️ v2.0 的范围规则变了:不是"我选了哪个空间",而是
 * **我拥有所有权的那些节点子树里的记录**。所以这一页不再接受任何范围参数 ——
 * 传空间 id 反而会绕开那条规则,服务端也不接受它。
 *
 * 超管能看到全部;其他人看不到任何一条时会得到一个明确的说明,
 * 而不是一个空表格(空表格会让人以为是"没有记录",而不是"没有权限")。
 */
export function AuditPage() {
  const logs = useAuditLogs(true);

  const items = logs.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-lg font-semibold text-slate-900">审计日志</h1>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        只写不删。登录、节点变更、所有者变更、授权调整、评论都会留痕。
        你能看到的是<b>你拥有所有权的节点</b>范围内的记录;超级管理员看到全部。
      </p>

      {logs.isError && (
        <div className="mt-4">
          <ErrorNote error={logs.error} />
        </div>
      )}

      {logs.isPending && <p className="mt-6 text-sm text-slate-400">加载中…</p>}

      {!logs.isPending && items.length === 0 && (
        <p className="mt-6 rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">
          没有可见的审计记录。
          <br />
          <span className="text-xs">
            你还没有任何节点的所有权 —— 部长对其部门下的记录、组长对其组下的记录可见。
          </span>
        </p>
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
