import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { Button } from '../components/ui';
import { useLogout, useMe } from '../features/auth/queries';
import { GrantDialog } from '../features/grants/GrantDialog';
import { useGrantDialog } from '../features/grants/dialog-store';
import { MembersDialog } from '../features/members/MembersDialog';
import { useMembersDialog } from '../features/members/dialog-store';
import { OrgTreePanel } from '../features/org/OrgTreePanel';
import { useOrgTree } from '../features/org/queries';
import { CommandPalette } from '../features/search/CommandPalette';
import { hasOpenModal } from '../lib/modal-store';
import { T_LABEL, T_META } from '../lib/typography';

/** 从路径里取出当前节点 id(`/n/:nodeId`)。 */
function activeNodeIdOf(pathname: string): string | undefined {
  const match = /^\/n\/([^/]+)/.exec(pathname);
  return match?.[1];
}

/**
 * 应用外壳(DESIGN.md §7.2):顶栏 + 组织树 + 主区域。
 *
 * ⚠️ v2.0 有两处与旧版不同:
 *   1. **左侧常驻整棵组织树** —— 不再有"先选空间再看树"这一步。
 *      登录进来就看到公司有哪些部门(读对所有登录用户开放,§5.3 规则一)。
 *   2. **权限弹窗挂在这里** —— 它由树上的齿轮按钮打开,而树就在这一层,
 *      所以状态放在这一层。放到路由页面里会导致"从树点开的弹窗
 *      要等页面切过去才出现"。
 *
 * v2.4 起这里挂的是**两个**弹窗:权限(能改什么)与成员(归属在哪)。
 * 两者刻意不合并 —— 归属是组织事实,权限是判定结果,混在一起会让
 * "移出成员 = 收回权限"变成一种反复出现的误解。
 */
export function AppLayout() {
  const me = useMe();
  const tree = useOrgTree();
  const logout = useLogout();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const grantTarget = useGrantDialog((state) => state.target);
  const openGrants = useGrantDialog((state) => state.open);
  const closeGrants = useGrantDialog((state) => state.close);
  const membersTarget = useMembersDialog((state) => state.target);
  const openMembers = useMembersDialog((state) => state.open);
  const closeMembers = useMembersDialog((state) => state.close);

  // Ctrl / Cmd + K 打开命令面板。全局快捷键挂在 window 上,
  // 因为用户可能正把焦点放在正文里 —— 那种时候也要能唤起搜索。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        // 已有模态盖在上面时不再叠加。少了这一句,权限 / 成员弹窗开着的时候
        // 按 Cmd+K 会在弹窗里再冒出一个搜索框(两者 z-index 不同,视觉上很乱)。
        // 这是全局快捷键必须知道"现在有没有模态"的唯一理由。
        if (hasOpenModal()) return;
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const user = me.data?.user;
  const activeNodeId = activeNodeIdOf(pathname);

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex flex-none items-center gap-4 border-b border-slate-200 px-4 py-2.5">
        <button
          type="button"
          className="flex items-center gap-2"
          onClick={() => void navigate('/')}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-sm font-semibold text-white">
            知
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-900">知源知识库</span>
        </button>

        {/*
          搜索框:文字用 `text-sm`(14px)—— 它是**组件级文字**(Atlassian `font.body`),
          不是细字印刷。上一轮把它放在 12px 那一档,是"看起来小"的直接来源之一。
          只有 `Ctrl K` 这个快捷键提示留在 12px(它就是给人扫一眼的)。
        */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex w-80 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-slate-400 transition-colors hover:border-slate-300 hover:bg-white"
        >
          <span className="flex-1 text-sm">搜索全公司内容…</span>
          <kbd
            className={`rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-slate-400 ${T_META}`}
          >
            Ctrl K
          </kbd>
        </button>

        <div className="flex-1" />

        {user?.isSuperAdmin === true && (
          <>
            <Button variant="secondary" onClick={() => void navigate('/admin/org')}>
              组织架构
            </Button>
            <Button variant="secondary" onClick={() => void navigate('/admin/users')}>
              人员
            </Button>
          </>
        )}

        {user !== undefined && (
          <div className="flex items-center gap-3 border-l border-slate-200 pl-4">
            <div className="text-right leading-tight">
              <div className={`text-slate-800 ${T_LABEL}`}>{user.name}</div>
              <div className={`font-mono text-slate-400 ${T_META}`}>{user.employeeNo}</div>
            </div>
            <div className="flex gap-0.5">
              <button
                type="button"
                className="rounded-md px-2 py-1.5 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                onClick={() => void navigate('/change-password')}
              >
                改密
              </button>
              <button
                type="button"
                disabled={logout.isPending}
                className="rounded-md px-2 py-1.5 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
                onClick={() => {
                  logout.mutate(undefined, {
                    onSettled: () => void navigate('/login', { replace: true }),
                  });
                }}
              >
                登出
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {tree.data !== undefined ? (
          <OrgTreePanel
            tree={tree.data}
            scopes={me.data?.scopes ?? []}
            isSuperAdmin={user?.isSuperAdmin === true}
            activeNodeId={activeNodeId}
            onOpenGrants={openGrants}
            onOpenMembers={openMembers}
          />
        ) : (
          <div className="flex h-full w-80 flex-none items-center justify-center border-r border-slate-200 bg-slate-50">
            <span className="text-sm text-slate-400">
              {tree.isError ? '组织结构加载失败' : '加载中…'}
            </span>
          </div>
        )}

        <main className="min-w-0 flex-1 overflow-auto bg-white">
          <Outlet />
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      )}

      {grantTarget !== null && (
        <GrantDialog
          nodeId={grantTarget.nodeId}
          title={grantTarget.title}
          onClose={closeGrants}
        />
      )}

      {membersTarget !== null && (
        <MembersDialog
          nodeId={membersTarget.nodeId}
          title={membersTarget.title}
          onClose={closeMembers}
        />
      )}
    </div>
  );
}
