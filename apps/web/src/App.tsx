import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { ErrorNote, FullScreenNote } from './components/ui';
import { isUnauthorized, needsPasswordChange, useMe, useSetupState } from './features/auth/queries';
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
 * ⚠️ v2.0 的三处结构变化:
 *
 *   1. **`/` 就是工作台**。不再有 `/spaces` 那一层 —— 登录后左侧已经常驻
 *      整棵组织树,再插一个"选择空间"的中间页只是让人多点一次。
 *   2. **`/s/:spaceId/p/:pageId` → `/n/:nodeId`**。空间与页面合并成一棵树后,
 *      路径里不再需要"空间"这一段。
 *   3. **新增 `/change-password`,并且它必须在 AppLayout 之外** ——
 *      强制改密时不能让人看到侧边栏(那里每一个入口点了都会报 403)。
 *
 * `/setup` 与 `/login` 刻意放在最外层(不套 RequireAuth)—— 它们存在的意义
 * 就是「还没登录」这个状态,套上守卫会变成死循环重定向。
 */
export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />

      {/* 需要登录,但**不**要求已改密 —— 改密页本身在这里 */}
      <Route element={<RequireAuth />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />

        {/* 已登录且已改密,才给完整的工作台 */}
        <Route element={<RequirePasswordChanged />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/n/:nodeId" element={<NodeDetailPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/admin/org" element={<OrgAdminPage />} />
            <Route path="/admin/users" element={<UsersAdminPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
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
 * 强制改密闸门。
 *
 * ⚠️ 这一层**不是安全边界** —— 真正的拦截在服务端全局守卫里:
 * 未改密时除「改密」与「登出」之外的所有接口一律 403
 * `PASSWORD_CHANGE_REQUIRED`(§6.1.2)。
 * 这里只是别让人看到一个满屏报错的界面。
 */
function RequirePasswordChanged() {
  const me = useMe();
  if (needsPasswordChange(me.data)) return <Navigate to="/change-password" replace />;
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
