import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { ErrorNote, FullScreenNote } from './components/ui';
import { isUnauthorized, useMe, useSetupState } from './features/auth/queries';
import { AppLayout } from './routes/AppLayout';
import { AuditPage } from './routes/AuditPage';
import { ChangePasswordPage } from './routes/ChangePasswordPage';
import { HomePage } from './routes/HomePage';
import { LoginPage } from './routes/LoginPage';
import { NodeDetailPage } from './routes/NodeDetailPage';
import { OrgAdminPage } from './routes/OrgAdminPage';
import { SearchPage } from './routes/SearchPage';
import { SetupPage } from './routes/SetupPage';
import { TrashPage } from './routes/TrashPage';
import { UsersAdminPage } from './routes/UsersAdminPage';

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
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/n/:nodeId" element={<NodeDetailPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/admin" element={<RequireSuperAdmin />}>
            <Route path="/admin/org" element={<OrgAdminPage />} />
            <Route path="/admin/users" element={<UsersAdminPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
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
