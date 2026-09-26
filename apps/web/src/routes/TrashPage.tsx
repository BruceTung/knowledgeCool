import { Button, ErrorNote } from '../components/ui';
import { useMe } from '../features/auth/queries';
import {
  usePurgeNode,
  useRestoreNode,
  useRunTrashPurge,
  useTrash,
  useTrashPolicy,
} from '../features/org/queries';

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
 *
 * v2.4 新增:回收站**会按保留策略自动清理**了。所以这里必须把"多久之后会消失"
 * 明确写出来 —— 一件东西会自己不见,而用户不知道,是最糟的沉默行为。
 * 天数来自服务端(`/trash/policy`)而不是写死在前端。
 */
export function TrashPage() {
  const trash = useTrash();
  const restore = useRestoreNode();
  const purge = usePurgeNode();
  const policy = useTrashPolicy();
  const purgeByPolicy = useRunTrashPurge();
  const me = useMe();

  const isSuperAdmin = me.data?.user.isSuperAdmin === true;
  const retentionDays = policy.data?.retentionDays ?? null;

  /**
   * 超管的手动清理。
   *
   * **先 `dryRun` 再真删**,并把待删清单摆给他看 —— 与 Excel 导入同一套思路:
   * 一个会删数据的动作,预览与实际执行必须走同一条路径,
   * 否则超管是照着"他没看过的那份清单"点确认的。
   */
  async function runPurgeByPolicy(): Promise<void> {
    const preview = await purgeByPolicy.mutateAsync(true);
    if (preview.retentionDays <= 0) {
      window.alert('自动清理已关闭(保留天数为 0),不会清理任何东西。');
      return;
    }
    if (preview.roots.length === 0) {
      window.alert(`没有删除满 ${String(preview.retentionDays)} 天的条目,无需清理。`);
      return;
    }

    const shown = preview.roots.slice(0, 10).map((root) => `· ${root.title}(${String(root.subtreeSize)} 个节点)`);
    const more =
      preview.roots.length > 10 ? `\n…还有 ${String(preview.roots.length - 10)} 条` : '';
    const ok = window.confirm(
      `将彻底删除 ${String(preview.roots.length)} 棵子树(删除满 ${String(preview.retentionDays)} 天):\n` +
        `${shown.join('\n')}${more}\n\n此操作不可恢复。继续?`,
    );
    if (!ok) return;
    await purgeByPolicy.mutateAsync(false);
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <nav className="text-xs text-slate-400">回收站</nav>

      <div className="mt-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-slate-900">回收站</h1>
          <p className="mt-1 text-sm text-slate-500">
            删除一律是软删除,进这里而不是直接消失。恢复会把整棵子树一起带回来。
          </p>

          {policy.data !== undefined && (
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              {policy.data.retentionDays > 0
                ? `这里的条目会在删除满 ${String(policy.data.retentionDays)} 天后被自动清理(每 ${String(policy.data.purgeIntervalHours)} 小时扫一次)。要留住某样东西,请在到期前恢复它。`
                : '自动清理已关闭 —— 回收站里的条目会一直保留,只能手动彻底删除。'}
            </p>
          )}
        </div>

        {isSuperAdmin && (
          <Button
            variant="secondary"
            className="flex-none"
            disabled={purgeByPolicy.isPending}
            title="按保留策略立即清理一次(会先给出待删清单让你确认)"
            onClick={() => {
              void runPurgeByPolicy();
            }}
          >
            {purgeByPolicy.isPending ? '处理中…' : '按保留策略清理'}
          </Button>
        )}
      </div>

      <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
        彻底删除
        <strong className="font-medium">不可逆</strong>
        ,并且门槛比移入回收站高一级:能改这个节点还不够,得是它或它上级的所有者。
        {retentionDays !== null && retentionDays > 0 && (
          <> 自动清理走的是同一条删除路径,但不需要任何人点确认 —— 它按时间自己发生。</>
        )}
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
        <ErrorNote error={restore.error ?? purge.error ?? purgeByPolicy.error} />
        <p className="text-[11px] leading-relaxed text-slate-400">
          这里只列出你有编辑权的已删内容。别人的回收站不会出现在这里。
        </p>
      </div>
    </div>
  );
}
