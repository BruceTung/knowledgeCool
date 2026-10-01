import { AUDIT_ACTIONS, AUDIT_ACTION_LABELS } from '@knowledgecool/shared';
import { useState } from 'react';

import { ErrorNote, Skeleton } from '../components/ui';
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
  const [action, setAction] = useState('');
  const logs = useAuditLogs(true, action);

  const items = logs.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-lg font-semibold text-slate-900">审计日志</h1>
      <p className="mt-1 text-sm leading-relaxed text-slate-500">
        只写不删。登录、节点变更、所有者变更、授权调整、评论都会留痕。 你能看到的是
        <b>你拥有所有权的节点</b>范围内的记录;超级管理员看到全部。
      </p>

      {/*
        按动作筛选(v2.14)。**服务端筛** —— 这一页是游标分页,
        在客户端过滤已加载的那几页会在"当前页没有匹配项"时显示
        「没有记录」,而更早的页里其实有。审计页恰恰最不能给错结论。
      */}
      <div className="mt-4 flex items-center gap-2">
        <label htmlFor="audit-action" className="text-sm text-slate-600">
          只看
        </label>
        <select
          id="audit-action"
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
          }}
          className="rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        >
          <option value="">全部动作</option>
          {AUDIT_ACTIONS.map((name) => (
            <option key={name} value={name}>
              {AUDIT_ACTION_LABELS[name] ?? name}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        {/*
          导出 CSV。带上当前的筛选条件 —— 导出「我看见的那些」而不是「全部」,
          否则用户筛完再导出,会得到一份与屏幕上不一致的文件。
        */}
        <a
          href={`/api/v1/audit-logs/export${action === '' ? '' : `?action=${encodeURIComponent(action)}`}`}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-700 transition-colors hover:bg-slate-50"
        >
          导出 CSV
        </a>

        {action !== '' && (
          <button
            type="button"
            onClick={() => {
              setAction('');
            }}
            className="rounded px-1.5 py-0.5 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            清除
          </button>
        )}
      </div>

      {logs.isError && (
        <div className="mt-4">
          <ErrorNote
            error={logs.error}
            onRetry={() => {
              void logs.refetch();
            }}
          />
        </div>
      )}

      {/* 骨架屏而不是「加载中…」:这一页是固定几列的表,骨架能让布局不跳 */}
      {logs.isPending && <Skeleton className="mt-6" lines={6} />}

      {!logs.isPending && items.length === 0 && (
        <p className="mt-6 rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          没有可见的审计记录。
          <br />
          <span className="text-sm">
            你还没有任何节点的所有权 —— 部长对其部门下的记录、组长对其组下的记录可见。
          </span>
        </p>
      )}

      {items.length > 0 && (
        <>
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-200">
                {/*
                  scope="col" 不是可选的礼节:没有它,屏幕阅读器**不会**把表头与
                  单元格关联起来,于是它念数据时只说「技术部, 2026/9/27, 修改可见范围」,
                  而不说哪一列是什么 —— 一张五列的表等于没法读。
                */}
                <th scope="col" className="py-2 font-normal">
                  时间
                </th>
                <th scope="col" className="py-2 font-normal">
                  操作者
                </th>
                <th scope="col" className="py-2 font-normal">
                  动作
                </th>
                <th scope="col" className="py-2 font-normal">
                  目标
                </th>
                <th scope="col" className="py-2 font-normal">
                  来源 IP
                </th>
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
                  <td className="py-2 text-slate-500">{item.ip ?? '—'}</td>
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
              className="mt-4 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              {logs.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
