import { Button, ErrorNote } from '../components/ui';
import { usePurgeNode, useRestoreNode, useTrash } from '../features/org/queries';

/**
 * 回收站(DESIGN.md §7.2)。
 *
 * ⚠️ 四处与 v1.x 不同:
 *   1. 路径从 `/spaces/:id/trash` 变成 **`/trash`** —— 没有"空间"这一层了,
 *      而回收站天然是"我所有能改的已删内容"(服务端按 `canEdit` 过滤),跨部门。
 *   2. 列表只显示**被删子树的根** —— 恢复是整棵子树一起回来的,
 *      把子孙单独列出来只会让人误以为要一个个恢复。
 *   3. 条目显示**原父节点是否还在树上** —— 不在的话恢复会挂到顶层,
 *      这件事必须在点之前告诉用户。
 *   4. 权限不再靠角色判断:能恢复就显示恢复,能彻底删除就显示彻底删除,
 *      **判断是服务端在列表里给的**(能不能看到这一条本身就是 `canEdit`)。
 */
export function TrashPage() {
  const trash = useTrash();
  const restore = useRestoreNode();
  const purge = usePurgeNode();

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <nav className="text-xs text-slate-400">回收站</nav>

      <h1 className="mt-2 text-xl font-semibold text-slate-900">回收站</h1>
      <p className="mt-1 text-sm text-slate-500">
        删除一律是软删除,进这里而不是直接消失。恢复会把整棵子树一起带回来。
      </p>

      <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
        彻底删除
        <strong className="font-medium">不可逆</strong>
        ,并且门槛比移入回收站高一级:能改这个节点还不够,得是它或它上级的所有者。
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
                  {new Date(item.deletedAt).toLocaleString('zh-CN')} · {item.deletedByName} 删除
                  {item.subtreeSize > 1 && ` · 含 ${String(item.subtreeSize - 1)} 个子节点`}
                </span>
                {!item.parentAlive && (
                  <span className="mt-0.5 block text-[11px] text-amber-700">
                    原来的上级节点也不在了 —— 恢复后会挂到顶层
                  </span>
                )}
              </span>

              <span className="flex flex-none items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={restore.isPending}
                  onClick={() => {
                    restore.mutate(item.id);
                  }}
                >
                  恢复
                </Button>
                <Button
                  variant="danger"
                  disabled={purge.isPending}
                  onClick={() => {
                    const label =
                      item.subtreeSize > 1
                        ? `「${item.title}」及其下 ${String(item.subtreeSize - 1)} 个节点`
                        : `「${item.title}」`;
                    if (window.confirm(`彻底删除 ${label}?此操作不可恢复。`)) {
                      purge.mutate(item.id);
                    }
                  }}
                >
                  彻底删除
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-2">
        <ErrorNote error={restore.error ?? purge.error} />
        <p className="text-[11px] leading-relaxed text-slate-400">
          这里只列出你有编辑权的已删内容。别人的回收站不会出现在这里。
        </p>
      </div>
    </div>
  );
}
