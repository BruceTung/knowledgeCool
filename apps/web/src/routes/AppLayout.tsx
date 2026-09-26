import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { avatarClass, Button } from '../components/ui';
import { useLogout, useMe } from '../features/auth/queries';
import { useCommentCounts } from '../features/comments/queries';
import { PageTreePanel } from '../features/pages/PageTreePanel';
import { usePageTree } from '../features/pages/queries';
import { CommandPalette } from '../features/search/CommandPalette';
import { useSpaces } from '../features/spaces/queries';

/**
 * 从 URL 里取出当前空间与当前页面。
 *
 * 用正则而不是 `useMatch`:布局路由位于子路由之上,拿不到子路由的 params,
 * 而路径形状是固定的、可控的。正则在这里更直观,也不会因为路由嵌套层级
 * 调整而悄悄失配。
 */
export function idsFromPath(pathname: string): { spaceId?: string; pageId?: string } {
  const page = /^\/s\/([0-9a-fA-F-]{36})\/p\/([0-9a-fA-F-]{36})/.exec(pathname);
  if (page?.[1] !== undefined) {
    return { spaceId: page[1], ...(page[2] === undefined ? {} : { pageId: page[2] }) };
  }
  const space = /^\/s\/([0-9a-fA-F-]{36})/.exec(pathname);
  if (space?.[1] !== undefined) return { spaceId: space[1] };
  return {};
}

/**
 * 应用外壳:顶栏 + 空间栏 + 页面树 + 主区域(DESIGN.md §7.2)。
 *
 * 页面树只在「已经选中某个空间」时出现 —— 在 `/spaces` 这类全局页面上
 * 显示一棵不属于任何空间的树是没有意义的。
 *
 * 全局检索是 `Ctrl / Cmd + K` 的命令面板,不占版面(§7.2)。
 */
export function AppLayout() {
  const me = useMe();
  const spaces = useSpaces();
  const logout = useLogout();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const { spaceId, pageId } = idsFromPath(pathname);
  const tree = usePageTree(spaceId);
  const commentCounts = useCommentCounts(spaceId);
  const user = me.data?.user;

  const [paletteOpen, setPaletteOpen] = useState(false);

  // Ctrl / Cmd + K 打开命令面板。挂在 document 上是唯一可行的做法:
  // 焦点可能在编辑器里,也可能在某个输入框里,没有单一的挂载点。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex h-12 flex-none items-center gap-3 border-b border-slate-200 px-4">
        <div className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-blue-50 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
          知
        </div>
        <span className="text-sm font-medium text-slate-900">知源知识库</span>

        <button
          type="button"
          onClick={() => {
            setPaletteOpen(true);
          }}
          className="ml-2 flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-400 hover:border-slate-300 hover:text-slate-600"
          title="全局检索"
        >
          <span>搜索知识库…</span>
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1 text-[10px]">
            Ctrl / ⌘ K
          </kbd>
        </button>

        <div className="flex-1" />

        {user !== undefined && (
          <div className="flex items-center gap-2">
            <div
              className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs ring-1 ${avatarClass(user.avatarColor)}`}
            >
              {Array.from(user.name)[0] ?? '?'}
            </div>
            <div className="leading-tight">
              <div className="text-xs text-slate-700">
                {user.name}
                {user.isSuperAdmin && (
                  <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700 ring-1 ring-amber-200">
                    超管
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-400">{user.email}</div>
            </div>
          </div>
        )}

        <Button
          variant="secondary"
          disabled={logout.isPending}
          onClick={() => {
            logout.mutate(undefined, {
              onSettled: () => void navigate('/login', { replace: true }),
            });
          }}
        >
          {logout.isPending ? '退出中…' : '退出'}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 空间栏只放标识字,名称走 title 提示 —— 横向空间留给页面树 */}
        <nav className="flex w-14 flex-none flex-col items-center gap-1 border-r border-slate-200 bg-slate-50 py-2">
          <NavLink
            to="/spaces"
            title="全部空间"
            className={({ isActive }) =>
              `flex h-8 w-8 items-center justify-center rounded-lg text-sm ${
                isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:bg-white/70'
              }`
            }
          >
            ⊞
          </NavLink>

          <NavLink
            to="/search"
            title="检索(也可用 Ctrl / Cmd + K)"
            className={({ isActive }) =>
              `flex h-8 w-8 items-center justify-center rounded-lg text-sm ${
                isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:bg-white/70'
              }`
            }
          >
            ⌕
          </NavLink>

          <div className="my-1 h-px w-6 flex-none bg-slate-200" />

          <div className="flex w-full flex-col items-center gap-1 overflow-auto">
            {spaces.data?.map((space) => (
              <Link
                key={space.id}
                to={`/s/${space.id}`}
                title={`${space.name} · ${String(space.memberCount)} 位成员`}
                className="flex-none"
              >
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm ring-1 ${
                    space.id === spaceId ? 'shadow-sm ring-slate-300' : ''
                  } ${avatarClass(space.color)}`}
                >
                  {space.letter}
                </span>
              </Link>
            ))}
          </div>
        </nav>

        {spaceId !== undefined &&
          (tree.data !== undefined ? (
            <PageTreePanel
              spaceId={spaceId}
              nodes={tree.data.nodes}
              role={tree.data.role}
              activePageId={pageId}
              commentCounts={commentCounts.data ?? {}}
            />
          ) : (
            <div className="flex h-full w-72 flex-none items-center justify-center border-r border-slate-200 bg-slate-50">
              <span className="text-xs text-slate-400">
                {tree.isError ? '页面树加载失败' : '加载中…'}
              </span>
            </div>
          ))}

        <main className="min-w-0 flex-1 overflow-auto bg-white">
          <Outlet />
        </main>
      </div>

      {/* 只在打开时挂载:关闭即卸载,状态自然清空 */}
      {paletteOpen && (
        <CommandPalette
          onClose={() => {
            setPaletteOpen(false);
          }}
          {...(spaceId === undefined ? {} : { spaceId })}
        />
      )}
    </div>
  );
}
