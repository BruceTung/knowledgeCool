import { type ReactNode, Suspense, lazy } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastHost } from './components/Toast';
import { ErrorNote, FullScreenNote } from './components/ui';
import { isUnauthorized, useMe, useSetupState } from './features/auth/queries';
import { AppLayout } from './routes/AppLayout';
import { LoginPage } from './routes/LoginPage';
import { SetupPage } from './routes/SetupPage';

/*
  ⚠️ v5.43 路由级代码分割(P1-3)。

  此前 10 个页面**全部**打进入口 bundle,实测 900,981 字节(881KB)——
  而绝大多数会话只用到其中三页:登录(未登录时)、工作台、
  节点详情(点进一篇文档)。审计、检索、两个管理页、导出这些
  首屏一个都用不到,却要所有人一起下载。

  这里用 `lazy` + 一次 `Suspense` 拆开。**刻意不逐页各写一个 Suspense**:
  那样每页都要重复一遍 fallback,而 Suspense 边界放在 `AppLayout` 之上
  就能覆盖全部懒加载页 —— 一次进入懒加载、一次回退,粒度反而更合适。

  ⚠️ **不要改成逐页 Suspense**:边界越多,切页时闪一下的机会越多。
  这里的取舍是"整页切换期间显示一行提示",换来首屏少下载几百 KB。

  ⚠️ 为什么 `LoginPage` / `SetupPage` / `AppLayout` **不懒加载**:
  前两者是未登录时唯一能渲染的页面(懒了会在最关键的一步多一次网络往返),
  布局是所有懒加载页的共同外壳,懒了等于每页都多一个请求。
*/
const HomePage = lazy(() => import('./routes/HomePage').then((m) => ({ default: m.HomePage })));
const NodeDetailPage = lazy(() =>
  import('./routes/NodeDetailPage').then((m) => ({ default: m.NodeDetailPage })),
);
const SearchPage = lazy(() =>
  import('./routes/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const AuditPage = lazy(() => import('./routes/AuditPage').then((m) => ({ default: m.AuditPage })));
const OrgAdminPage = lazy(() =>
  import('./routes/OrgAdminPage').then((m) => ({ default: m.OrgAdminPage })),
);
const UsersAdminPage = lazy(() =>
  import('./routes/UsersAdminPage').then((m) => ({ default: m.UsersAdminPage })),
);
const ChangePasswordPage = lazy(() =>
  import('./routes/ChangePasswordPage').then((m) => ({ default: m.ChangePasswordPage })),
);

/**
 * 路由表(DESIGN.md §7.2)。
 *
 * 四条结构性的约定:
 *
 *   1. **`/` 就是工作台**。不再有 `/spaces` 那一层 —— 登录后左侧已经常驻
 *      整棵组织树,再插一个"选择空间"的中间页只是让人多点一次。
 *   2. **`/s/:spaceId/p/:pageId` → `/n/:nodeId`**。空间与页面合并成一棵树后,
 *      路径里不再需要"空间"这一段。
 *   3. **`/setup` 与 `/login` 在最外层**(不套 `RequireAuth`)——
 *      它们存在的意义就是「还没登录」这个状态,套上守卫会变成死循环重定向。
 *   4. **`/change-password` 也在最外层**(v2.4 的变化)。
 *      首次改密的人**没有会话**,套 `RequireAuth` 会被立刻踢回登录页 ——
 *      那就正好复现了用户反馈的「初次登录后回不到 login 页面」的另一面:
 *      他被卡在一个永远跳走的循环里。
 *      这一页自己判断模式(有一次性凭证 / 有会话 / 都没有)。
 *   5. **没有「强制改密闸门」这一层了**。原来那个 `RequirePasswordChanged`
 *      是配合"首登也发会话"的旧设计;现在首登不发会话,就不存在
 *      "已登录但未改密"的状态,那一层自然也不需要了。
 */
export function App() {
  return (
    <>
      {/* 兜底包在路由**外面**:任何一页渲染抛错都不该变成白屏 */}
      <ErrorBoundary>
        {/*
          Suspense 边界放在 Routes **之外** —— 覆盖全部懒加载页,
          一次进入、一次回退。见上面那段关于"为什么不逐页拆"的说明。
        */}
        <Suspense fallback={<FullScreenNote>正在加载这一页…</FullScreenNote>}>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/change-password" element={<ChangePasswordPage />} />

            <Route element={<RequireAuth />}>
              <Route element={<AppLayout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/n/:nodeId" element={<NodeDetailPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/admin" element={<RequireSuperAdmin />}>
                  <Route path="/admin/org" element={<OrgAdminPage />} />
                  <Route path="/admin/users" element={<UsersAdminPage />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>

      {/* toast 挂在最外层:未登录的页面(登录 / 引导 / 改密)也要能弹提示 */}
      <ToastHost />
    </>
  );
}

/**
 * 登录守卫。
 *
 * 关键区分:401 代表「还没登录」这个**正常状态**,要静默送去登录页;
 * 其他错误(500、网络不通)是**故障**,必须显式告诉用户,
 * 否则一次后端崩溃会表现成「反复跳回登录页,怎么登都登不进去」。
 */
function RequireAuth() {
  const me = useMe();
  const setupState = useSetupState();

  if (me.isPending || setupState.isPending) {
    return <FullScreenNote>正在加载…</FullScreenNote>;
  }

  if (isUnauthorized(me.error)) {
    return <Navigate to={setupState.data?.required === true ? '/setup' : '/login'} replace />;
  }

  if (me.isError) {
    return (
      <FullScreenNote>
        <span className="block text-slate-700">无法连接到服务</span>
        <span className="mt-2 block max-w-sm">
          <ErrorNote error={me.error} />
        </span>
      </FullScreenNote>
    );
  }

  return <Outlet />;
}

/**
 * 超管守卫(**只负责体验,不是安全边界**)。
 *
 * 服务端每个接口各自判权(§5.1) —— 一个非管理员把请求直接打过去照样是 403。
 * 这一层解决的是另一件事:他**手工敲地址**进到 `/admin/users` 时,
 * 应该看到一句人话,而不是一屏「403 Forbidden」的红色报错。
 *
 * 导航里的入口本来就按 `isSuperAdmin` 隐藏了,所以正常路径下走不到这里。
 */
function RequireSuperAdmin() {
  const me = useMe();

  if (me.data !== undefined && !me.data.user.isSuperAdmin) {
    return (
      <div className="p-8">
        <h1 className="text-lg font-medium text-slate-900">需要管理员权限</h1>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">
          人员管理与组织架构维护只对管理员开放。
          <br />
          如果你只是想看某个部门里有谁,在左侧组织树里悬停该节点、点 ☰。
        </p>
      </div>
    );
  }

  return <Outlet />;
}

function NotFound(): ReactNode {
  return (
    <div className="p-8">
      <h1 className="text-lg font-medium text-slate-900">页面不存在</h1>
      <p className="mt-1 text-sm text-slate-500">检查一下地址,或从左侧组织树重新进入。</p>
    </div>
  );
}
