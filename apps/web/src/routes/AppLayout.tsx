import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { ErrorNote } from '../components/ui';
import { useLogout, useMe } from '../features/auth/queries';
import { GrantDialog } from '../features/grants/GrantDialog';
import { useGrantDialog } from '../features/grants/dialog-store';
import { VisibilityDialog } from '../features/visibility/VisibilityDialog';
import { useVisibilityDialog } from '../features/visibility/dialog-store';
import { MembersDialog } from '../features/members/MembersDialog';
import { useMembersDialog } from '../features/members/dialog-store';
import { OrgTreePanel } from '../features/org/OrgTreePanel';
import { useOrgTree } from '../features/org/queries';
import { CommandPalette } from '../features/search/CommandPalette';
import { hasOpenModal } from '../lib/modal-store';
import { useDocumentTitle } from '../lib/use-document-title';
import { T_META } from '../lib/typography';

/**
 * 深色顶栏上的按钮规格(v2.17)。
 *
 * 收敛成常量而不是每处各写一遍 —— 顶栏上有四个按钮(组织架构 / 人员 / 改密 / 登出),
 * 各写一遍的代价是它们迟早长得不一样(这正是"图标、字号、字样都不对称"
 * 那类反馈的来源)。
 *
 * ⚠️ 高度 36px(`h-9`)而不是原来的"内边距撑出来":
 * 用户此前反馈过"点着太费劲",而 24px 只是**下限**(Apple HIG / WCAG 2.2);
 * 顶栏这种一眼就要点的位置给到 36px 更稳。
 *
 * `CHROME_BTN_ON` 是"当前所在页"的高亮:青色描边 + 半透明底。
 */
const CHROME_BTN =
  'inline-flex h-9 flex-none items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors';
const CHROME_BTN_OFF =
  'border border-sky-400/20 text-slate-300 hover:border-sky-400/40 hover:bg-white/10 hover:text-white';
const CHROME_BTN_ON = 'bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/50';

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
 *      登录进来就看到公司有哪些部门(默认读对所有登录用户开放,§5.3 规则一;
 *      受限节点的整棵子树由服务端摘掉,前端拿不到也就画不出来)。
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
  const visibilityTarget = useVisibilityDialog((state) => state.target);
  const closeVisibility = useVisibilityDialog((state) => state.close);
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

  /**
   * 标签页标题(v2.12)。此前所有页面都叫「知源 KnowledgeCool」,
   * 同时开几篇文档时标签栏上分不出谁是谁。
   *
   * ⚠️ 文档页(/n/*)**刻意不在这里设**:它要用文档自己的标题,而子组件的
   * effect 先于父组件跑 —— 这里再设一次会把子组件刚设好的标题盖掉。
   */
  const routeTitle =
    pathname === '/'
      ? '工作台'
      : pathname.startsWith('/search')
        ? '检索'
        : pathname.startsWith('/audit')
          ? '审计日志'
          : pathname.startsWith('/admin/org')
            ? '组织架构'
            : pathname.startsWith('/admin/users')
              ? '人员管理'
              : undefined;
  useDocumentTitle(routeTitle);

  return (
    <div className="flex h-full flex-col bg-white">
      {/*
        `data-print='hide'` 是**打印时必须有的**(v2.16):打印样式不再靠
        `header` 标签名猜"这是不是框架"(文档页的页头也是 <header>,那要印)。
        少了这个标记,打印稿的第一行会是顶栏。
      */}
      <header
        data-print="hide"
        /*
          `kc-chrome` = 深色"控制台"底面(CSS 里定义了网格 + 光晕 + 渐变,
          见 styles.css 的「科技感外壳」一节)。
        */
        className="kc-chrome flex flex-none items-center gap-4 border-b border-sky-500/15 px-4 py-2.5"
      >
        <button
          type="button"
          className="flex flex-none items-center gap-2.5"
          onClick={() => void navigate('/')}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-base font-semibold text-white shadow-lg shadow-sky-500/25">
            知
          </span>
          <span className="text-base font-semibold tracking-tight text-white">知源知识库</span>
        </button>

        {/*
          搜索框:文字用 `text-sm`(14px)—— 它是**组件级文字**(Atlassian `font.body`)。
          只有 `Ctrl K` 这个快捷键提示留在 12px(它就是给人扫一眼的)。

          深色底面之后三处跟着改:边框改成半透明青色(纯灰边在深底上会"脏"),
          底色用 `white/5` 而不是纯白(纯白块在深底上过于抢眼,压过正文)。
        */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex w-80 flex-none items-center gap-2 rounded-lg border border-sky-400/20 bg-white/5 px-3 py-2 text-left text-slate-400 transition-colors hover:border-sky-400/40 hover:bg-white/10"
        >
          <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 flex-none" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <span className="flex-1 text-sm">搜索全公司内容…</span>
          <kbd
            className={`rounded border border-sky-400/20 bg-white/5 px-1.5 py-0.5 font-sans text-slate-400 ${T_META}`}
          >
            Ctrl K
          </kbd>
        </button>

        <div className="flex-1" />

        {user?.isSuperAdmin === true && (
          <>
            {/*
              当前所在页要有**明确的高亮**。此前这两个按钮永远一个样子 ——
              点进「组织架构」之后,顶栏上看不出自己在哪里(只有标签页标题变了)。
            */}
            <button
              type="button"
              className={`${CHROME_BTN} ${pathname.startsWith('/admin/org') ? CHROME_BTN_ON : CHROME_BTN_OFF}`}
              onClick={() => void navigate('/admin/org')}
            >
              组织架构
            </button>
            <button
              type="button"
              className={`${CHROME_BTN} ${pathname.startsWith('/admin/users') ? CHROME_BTN_ON : CHROME_BTN_OFF}`}
              onClick={() => void navigate('/admin/users')}
            >
              人员
            </button>
          </>
        )}

        {user !== undefined && (
          /*
            ⚠️ 用户区是用户明确圈出来"太小"的两处之一,所以这一版一次改到位:

            · **加了头像**。原来只有两行小字,在一片灰里既小又认不出是"我的账号";
              有了圆形徽标之后它是**一个块**,一眼就能定位。
            · **姓名 14 → 16px、工号 12 → 14px 并保留等宽**
              (工号是标识符,等宽字体让 KC003 这种串更好认)。
            · **改密 / 登出 从"两个没有边界的文字"变成两个按钮**。
              原来它们是裸文字,底色透明 —— 用户看不出那里可以点,
              而且点击区只有文字本身那么大。现在是 36px 高、带边框的按钮。
            · **管理员徽章**:超管在顶栏就能看出自己的身份,
              不用去人员页确认。
          */
          <div className="flex flex-none items-center gap-3 border-l border-sky-400/15 pl-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gradient-to-br from-sky-400/25 to-blue-600/25 text-base font-semibold text-sky-200 ring-1 ring-sky-400/40">
                {user.name.slice(0, 1)}
              </span>
              <div className="leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="text-base font-medium text-white">{user.name}</span>
                  {user.isSuperAdmin && (
                    <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-xs font-medium text-sky-200 ring-1 ring-sky-400/30">
                      管理员
                    </span>
                  )}
                </div>
                <div className="font-mono text-sm text-slate-400">{user.employeeNo}</div>
              </div>
            </div>
            <div className="flex flex-none items-center gap-1.5">
              <button
                type="button"
                className={`${CHROME_BTN} ${CHROME_BTN_OFF}`}
                onClick={() => void navigate('/change-password')}
              >
                改密
              </button>
              <button
                type="button"
                disabled={logout.isPending}
                className={`${CHROME_BTN} ${CHROME_BTN_OFF} disabled:opacity-50`}
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
          <div className="hidden h-full w-72 flex-none flex-col items-center justify-center gap-2 border-r border-slate-200 bg-slate-50 p-4 md:flex xl:w-80">
            {tree.isError ? (
              /*
                ⚠️ v2.16:原来这里只有一句「组织结构加载失败」—— 既没有原因,
                也没有重试入口。而**全站导航都依赖这棵树**,用户唯一的出路是刷新整页。
                SearchPage / AuditPage / NodeDetailPage 三处都给了 ErrorNote + 重试,
                只有这条最关键的路没有 —— 不一致本身就是 bug。
              */
              <>
                <span className="text-sm text-slate-500">组织结构加载失败</span>
                <ErrorNote error={tree.error} onRetry={() => void tree.refetch()} />
              </>
            ) : (
              <span className="text-sm text-slate-500">加载中…</span>
            )}
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

      {visibilityTarget !== null && (
        <VisibilityDialog
          nodeId={visibilityTarget.nodeId}
          title={visibilityTarget.title}
          onClose={closeVisibility}
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
