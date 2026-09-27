import { Link } from 'react-router-dom';

import { ErrorNote } from '../components/ui';
import { useMe } from '../features/auth/queries';
import { useOrgTree } from '../features/org/queries';
import { buildTree } from '../features/org/tree-utils';
import { usePersonal } from '../lib/personal-store';

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
/** 相对时间。「3 分钟前」比「2026/9/27 02:35」好读,而且不占宽度。 */
function relativeTime(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return String(minutes) + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return String(hours) + ' 小时前';
  const days = Math.floor(hours / 24);
  if (days < 30) return String(days) + ' 天前';
  return new Date(at).toLocaleDateString('zh-CN');
}

export function HomePage() {
  const me = useMe();
  const tree = useOrgTree();

  /*
    ⚠️ 这两行必须在**早退之前**(v2.14)。

    它们原本写在下面算 recents 的地方,而那里在所有 `if (tree.isPending) return` 之后 ——
    那违反 hooks 规则:首次渲染(数据还没回来)时这两个 hook 不会被调用,
    数据回来之后的渲染里却会,调用顺序变了。React 会直接抛错,
    而 lint 的 react-hooks/rules-of-hooks 在我跑 typecheck 时就把这条拦下来了。
  */
  const personalRecent = usePersonal((state) => state.recent);
  const personalFavorites = usePersonal((state) => state.favorites);

  if (tree.isPending) return <p className="p-8 text-sm text-slate-500">加载中…</p>;
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

  /*
    个人视图的两段(最近浏览 / 我的收藏)。

    ⚠️ 一律**用树来过滤**这两份本地列表,而不是直接显示。两个原因都不是理论问题:
      · 那篇文档可能已经被**删掉**了 —— 点进去是 404,用户会以为系统坏了;
      · 那篇文档可能已经**改成受限**、而他不在名单里 —— 本地列表是旧的,
        直接显示等于把标题重新漏给他一次(树上已经挡住了,这里漏就白挡了)。
    树是服务端算过可见性的,拿它当"现在还能看什么"的准绳,这两件事一起解决。
  */
  const visibleIds = new Set(tree.data.nodes.map((item) => item.id));
  const titleOf = new Map(tree.data.nodes.map((item) => [item.id, item.title]));
  const recents = personalRecent.filter((item) => visibleIds.has(item.id));
  const favoriteIds = personalFavorites.filter((id) => visibleIds.has(id));

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
          <div className="text-sm font-medium text-slate-700">你的组织归属</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {scopes.map((scope) => (
              <Link
                key={scope.nodeId}
                to={`/n/${scope.nodeId}`}
                className="rounded bg-white px-2 py-0.5 text-sm text-slate-600 ring-1 ring-slate-200 hover:text-slate-900"
              >
                {scope.path}
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            你可以在自己所属的节点下面新建内容;新建出来的东西归你所有,
            你的上级同样可以修改。
          </p>
        </div>
      )}

      {recents.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-slate-700">最近浏览</h2>
          <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
            {recents.slice(0, 6).map((item) => (
              <li key={item.id}>
                <Link
                  to={'/n/' + item.id}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                    {titleOf.get(item.id) ?? item.title}
                  </span>
                  <span className="flex-none text-xs text-slate-500">{relativeTime(item.at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {favoriteIds.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-slate-700">我的收藏 · {favoriteIds.length}</h2>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {favoriteIds.map((id) => (
              <Link
                key={id}
                to={'/n/' + id}
                className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 transition-colors hover:border-slate-300 hover:bg-slate-50"
              >
                <span className="flex-none text-amber-500">★</span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                  {titleOf.get(id) ?? id}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <h2 className="mt-8 text-sm font-medium text-slate-700">公司部门</h2>
      {departments.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          <p className="text-sm text-slate-500">组织架构还是空的。</p>
          <p className="mt-1 text-sm text-slate-500">
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
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-blue-50 text-sm font-medium text-blue-700 ring-1 ring-blue-200">
                  {department.title.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                  {department.title}
                </span>
              </div>
              <div className="mt-2 truncate text-xs text-slate-500">
                {department.children.length} 个子节点 · 负责人 {department.ownerName}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
