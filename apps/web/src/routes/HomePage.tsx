import { Link } from 'react-router-dom';

import { ErrorNote } from '../components/ui';
import { useMe } from '../features/auth/queries';
import { useOrgTree } from '../features/org/queries';
import { buildTree } from '../features/org/tree-utils';

/**
 * 工作台首页(DESIGN.md §7.2 的 `/`)。
 *
 * ⚠️ **登录后直接落到这里,不再有"选择空间"这一步** —— 左侧已经常驻整棵
 * 组织树,再插一个空间列表页只会让人多点一次。
 *
 * 这一页的职责是回答两个问题:
 *   1. 公司有哪些部门(卡片网格,点进去就是该部门的节点)
 *   2. 我在哪几段里(我的组织归属 —— 决定了我能改什么)
 */
export function HomePage() {
  const me = useMe();
  const tree = useOrgTree();

  if (tree.isPending) return <p className="p-8 text-sm text-slate-400">加载中…</p>;
  if (tree.isError) {
    return (
      <div className="p-8">
        <ErrorNote error={tree.error} />
      </div>
    );
  }

  const departments = buildTree(tree.data.nodes);
  const scopes = me.data?.scopes ?? [];
  const editableCount = tree.data.editableNodeIds.length;

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-xl font-semibold text-slate-900">
        你好,{me.data?.user.name ?? ''}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        全公司 {tree.data.nodes.length} 个节点,其中 {editableCount} 个你可以编辑。
      </p>

      {scopes.length > 0 && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-xs font-medium text-slate-700">你的组织归属</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {scopes.map((scope) => (
              <Link
                key={scope.nodeId}
                to={`/n/${scope.nodeId}`}
                className="rounded bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200 hover:text-slate-900"
              >
                {scope.path}
              </Link>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            你可以在自己所属的节点下面新建内容;新建出来的东西归你所有,
            你的上级同样可以修改。
          </p>
        </div>
      )}

      <h2 className="mt-8 text-sm font-medium text-slate-700">公司部门</h2>
      {departments.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          <p className="text-sm text-slate-400">组织架构还是空的。</p>
          <p className="mt-1 text-xs text-slate-400">
            管理员可以到「组织架构」里建部门,或者用 Excel 一次性导入全员名单。
          </p>
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {departments.map((department) => (
            <Link
              key={department.id}
              to={`/n/${department.id}`}
              className="rounded-xl border border-slate-200 p-4 transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-blue-50 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
                  {department.title.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                  {department.title}
                </span>
              </div>
              <div className="mt-2 truncate text-[11px] text-slate-400">
                {department.children.length} 个子节点 · 负责人 {department.ownerName}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
