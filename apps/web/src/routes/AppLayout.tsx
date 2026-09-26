import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { avatarClass, Button } from '../components/ui';
import { useLogout, useMe } from '../features/auth/queries';
import { useSpaces } from '../features/spaces/queries';

/**
 * 应用外壳:顶栏 + 左侧空间栏 + 主区域。
 *
 * 这里只到「空间」这一层 —— M3 会在同一个左栏里挂上页面树,
 * 所以布局骨架现在就要立好,免得那时再重排一次。
 */
export function AppLayout() {
  const me = useMe();
  const spaces = useSpaces();
  const logout = useLogout();
  const navigate = useNavigate();

  const user = me.data?.user;

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex h-12 flex-none items-center gap-3 border-b border-slate-200 px-4">
        <div className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-blue-50 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
          知
        </div>
        <span className="text-sm font-medium text-slate-900">知源知识库</span>

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
        <aside className="flex w-60 flex-none flex-col gap-1 overflow-auto border-r border-slate-200 bg-slate-50 p-3">
          <div className="mb-1 px-2 text-[11px] font-medium tracking-wide text-slate-400">
            我的空间
          </div>

          {spaces.isPending && <p className="px-2 text-xs text-slate-400">加载中…</p>}
          {spaces.isError && <p className="px-2 text-xs text-red-600">空间列表加载失败</p>}
          {spaces.data?.length === 0 && (
            <p className="px-2 text-xs text-slate-400">还没有空间,去「全部空间」建一个</p>
          )}

          {spaces.data?.map((space) => (
            <NavLink
              key={space.id}
              to={`/s/${space.id}`}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:bg-white/70'
                }`
              }
            >
              <span
                className={`flex h-5 w-5 flex-none items-center justify-center rounded text-[11px] ring-1 ${avatarClass(space.color)}`}
              >
                {space.letter}
              </span>
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <span className="flex-none text-[11px] text-slate-400">{space.memberCount}</span>
            </NavLink>
          ))}

          <NavLink
            to="/spaces"
            className={({ isActive }) =>
              `mt-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:bg-white/70'
              }`
            }
          >
            全部空间 →
          </NavLink>
        </aside>

        <main className="min-w-0 flex-1 overflow-auto bg-white">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
