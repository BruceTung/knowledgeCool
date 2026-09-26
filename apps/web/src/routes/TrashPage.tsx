import { can } from '@knowledgecool/shared';
import { Link, useParams } from 'react-router-dom';

import { Button, ErrorNote } from '../components/ui';
import { usePageTree, usePurgePage, useRestorePage, useTrash } from '../features/pages/queries';

/**
 * 空间回收站(DESIGN.md §7.2)。
 *
 * 列表只显示**被删子树的根** —— 恢复是整棵子树一起回来的,
 * 所以子孙单独列出来只会让人误以为要一个个恢复。
 *
 * 路径与 DESIGN §6.2 原表的 `/trash` 不同,改成 `/spaces/:id/trash`:
 * 回收站天然以空间为界(权限、路径、恢复行为都依赖空间),
 * 做成全局列表反而要额外处理跨空间权限。已在 DESIGN v1.6 同步。
 */
export function TrashPage() {
  const { spaceId } = useParams<{ spaceId: string }>();

  if (spaceId === undefined || spaceId === '') {
    return <p className="p-8 text-sm text-slate-500">缺少空间标识。</p>;
  }
  return <TrashView spaceId={spaceId} />;
}

function TrashView({ spaceId }: { spaceId: string }) {
  const trash = useTrash(spaceId);
  const tree = usePageTree(spaceId);
  const restore = useRestorePage(spaceId);
  const purge = usePurgePage(spaceId);

  const role = tree.data?.role ?? 'viewer';
  const canRestore = can(role, 'page.restore');
  const canPurge = can(role, 'page.purge');

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <nav className="text-xs text-slate-400">
        <Link to={`/s/${spaceId}`} className="hover:text-slate-600">
          空间首页
        </Link>
        <span> / </span>
        <span>回收站</span>
      </nav>

      <h1 className="mt-2 text-xl font-semibold text-slate-900">回收站</h1>
      <p className="mt-1 text-sm text-slate-500">
        删除一律是软删除,进这里而不是直接消失。恢复会把整棵子树一起带回来。
      </p>

      <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
        彻底删除<strong className="font-medium">不可逆</strong>
        ,且需要空间管理员权限 —— 门槛比移入回收站高是有意的。
      </div>

      {trash.isPending && <p className="mt-6 text-sm text-slate-400">加载中…</p>}
      {trash.isError && (
        <div className="mt-6">
          <ErrorNote error={trash.error} />
        </div>
      )}

      {trash.isSuccess && trash.data.length === 0 && (
        <p className="mt-6 rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">
          回收站是空的。
        </p>
      )}

      {trash.isSuccess && trash.data.length > 0 && (
        <ul className="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {trash.data.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-900">{item.title}</span>
                <span className="block text-xs text-slate-400">
                  {new Date(item.deletedAt).toLocaleString('zh-CN')}
                  {item.descendantCount > 0 && ` · 含 ${String(item.descendantCount)} 个子页面`}
                </span>
              </span>

              <span className="flex flex-none items-center gap-2">
                {canRestore && (
                  <Button
                    variant="secondary"
                    disabled={restore.isPending}
                    onClick={() => {
                      restore.mutate(item.id);
                    }}
                  >
                    恢复
                  </Button>
                )}
                {canPurge && (
                  <Button
                    variant="danger"
                    disabled={purge.isPending}
                    onClick={() => {
                      const label =
                        item.descendantCount > 0
                          ? `「${item.title}」及其 ${String(item.descendantCount)} 个子页面`
                          : `「${item.title}」`;
                      if (window.confirm(`彻底删除 ${label}?此操作不可恢复。`)) {
                        purge.mutate(item.id);
                      }
                    }}
                  >
                    彻底删除
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-2">
        <ErrorNote error={restore.error ?? purge.error} />
        {!canRestore && trash.isSuccess && (
          <p className="text-xs text-slate-400">
            你的角色是只读成员或评论者,只能查看回收站内容。
          </p>
        )}
      </div>
    </div>
  );
}
