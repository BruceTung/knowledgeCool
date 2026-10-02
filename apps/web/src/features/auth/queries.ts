/**
 * 认证相关的服务端状态(DESIGN.md §7.3:服务端状态交给 TanStack Query)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuthUser,
  ChangePasswordInput,
  CredentialsInput,
  InitialPasswordInput,
  LoginResponse,
  MeResponse,
  SetupInput,
} from '@knowledgecool/shared';

import { ApiError, apiFetch, apiSend } from '../../lib/api';
import { clearSessionExpired } from '../../lib/session-expiry';

export interface SetupState {
  required: boolean;
}

/**
 * 库里是否还没有用户。决定访问 `/` 时去引导页还是登录页。
 *
 * 这是个**公开接口**,未登录时也能拿到答案 —— 否则前端只能靠
 * "试着提交并接住 403"来判断该显示哪个页面。
 */
export function useSetupState() {
  return useQuery({
    queryKey: ['setup-state'],
    queryFn: () => apiFetch<SetupState>('/auth/setup-state'),
    retry: false,
  });
}

/**
 * 当前登录用户 + 我的组织归属。
 *
 * `retry: false` 是刻意的:401 在这里代表「未登录」这个**正常状态**,
 * 不是需要重试的故障。默认重试会让每个未登录的访客都白等一轮。
 */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<MeResponse>('/auth/me'),
    retry: false,
  });
}

/** 把「未登录」与其他错误区分开 —— 前者要静默跳转,后者要显式报错。 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'UNAUTHORIZED';
}

/**
 * 登录。
 *
 * ⚠️ **返回的是两种情况**,不是"一个用户"(v2.4):
 *   - `kind: 'session'` → 服务端已写 Cookie,正常进工作台
 *   - `kind: 'password-change-required'` → **服务端没有写 Cookie**,
 *     只给了一张 10 分钟的一次性凭证,前端要跳改密页
 *
 * 所以缓存失效**只在真正建立会话时做** —— 首登那条路径下
 * `me` 必然 401,去 invalidate 它只是白跑一趟请求。
 */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CredentialsInput) => apiSend<LoginResponse>('POST', '/auth/login', input),
    onSuccess: (result) => {
      if (result.kind === 'password-change-required') return;

      /*
        ⚠️ v4.9:登录成功要把"会话已过期"的标记清掉。
        否则那条全局横幅会一直挂着 —— 用户明明已经重新登录成功了,
        界面还在说"请重新登录",比不提示更让人困惑。
      */
      clearSessionExpired();

      // 清掉上一个身份残留的缓存再取新的。只 invalidate ['me'] 是不够的:
      // 组织树里带着"我能不能改"的标记,换了人就全错了。
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['org'] });
      void queryClient.invalidateQueries({ queryKey: ['setup-state'] });
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupInput) => apiSend<AuthUser>('POST', '/auth/setup', input),
    onSuccess: () => {
      // 首管建成即已登录,同样要清掉可能残留的过期标记
      clearSessionExpired();
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['setup-state'] });
    },
  });
}

/**
 * **首次改密** —— 凭登录时拿到的一次性凭证,**不要原密码**。
 *
 * 成功后**不会**有会话:用户得用新密码重新登录一次。
 * 所以这里没有 `invalidateQueries(['me'])` 之类的东西 ——
 * 改完那一刻系统里没有"当前用户"。
 */
export function useSetInitialPassword() {
  return useMutation({
    mutationFn: (input: InitialPasswordInput) =>
      apiSend<void>('POST', '/auth/initial-password', input),
  });
}

/**
 * **已登录用户**主动改密(顶栏那个「改密」入口)。需要当前密码。
 *
 * 成功后必须重取 `me` 之类的缓存吗?不必 —— 会话不受影响,
 * 用户画像里的字段也没变(密码不在画像里)。
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      apiSend<void>('POST', '/auth/change-password', input),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend<void>('POST', '/auth/logout'),
    onSettled: () => {
      // 无论成功与否都清空缓存 —— 登出失败时留着上一个用户的缓存更危险。
      queryClient.clear();
    },
  });
}
