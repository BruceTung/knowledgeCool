import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { ErrorNote, FullScreenNote } from './components/ui';
import { isUnauthorized, useMe, useSetupState } from './features/auth/queries';
import { AppLayout } from './routes/AppLayout';
import { LoginPage } from './routes/LoginPage';
import { MembersPage } from './routes/MembersPage';
import { PageDetailPage } from './routes/PageDetailPage';
import { SetupPage } from './routes/SetupPage';
import { SpaceOverviewPage } from './routes/SpaceOverviewPage';
import { SpacesHome } from './routes/SpacesHome';
import { TrashPage } from './routes/TrashPage';

/**
 * 路由表(DESIGN.md §7.2)。
 *
 * M2 落地:`/setup`、`/login`、`/spaces`、`/s/:spaceId`(概览)、`/s/:spaceId/members`。
 * M3 起 `/s/:spaceId` 会换成「页面树 + 编辑器」,但那只换组件、不动路由结构。
 *
 * `/setup` 与 `/login` 刻意放在外层(不套 RequireAuth)——
 * 它们存在的意义就是「还没登录」这个状态,套上守卫会变成死循环重定向。
 */
export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/spaces" replace />} />
        <Route path="/spaces" element={<SpacesHome />} />
        <Route path="/s/:spaceId" element={<SpaceOverviewPage />} />
        <Route path="/s/:spaceId/p/:pageId" element={<PageDetailPage />} />
        <Route path="/s/:spaceId/trash" element={<TrashPage />} />
        <Route path="/s/:spaceId/members" element={<MembersPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/**
 * 登录守卫。
 *
 * 关键区分:401 代表「还没登录」这个**正常状态**,要静默送去登录页;
 * 其他错误(500、网络不通)是**故障**,必须显式告诉用户,
 * 否则一次后端崩溃会表现成「反复跳回登录页,怎么登都进不去」。
 */
function RequireAuth({ children }: { children: ReactNode }) {
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

  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="p-8">
      <h1 className="text-lg font-medium text-slate-900">页面不存在</h1>
      <p className="mt-1 text-sm text-slate-500">检查一下地址,或从左侧空间列表重新进入。</p>
    </div>
  );
}
