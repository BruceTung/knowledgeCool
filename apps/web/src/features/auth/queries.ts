/**
 * 认证相关的服务端状态(DESIGN.md §7.3:服务端状态交给 TanStack Query)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, ChangePasswordInput, CredentialsInput, MeResponse, SetupInput } from '@knowledgecool/shared';

import { ApiError, apiFetch, apiSend } from '../../lib/api';

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
 * 是否卡在"必须先改密"上。
 *
 * 服务端**已经**把所有其他接口挡住了(403 `PASSWORD_CHANGE_REQUIRED`),
 * 前端这一层只是为了不让人看到一个满屏报错的界面。
 * 别把它当成安全边界 —— 边界在服务端守卫里。
 */
export function needsPasswordChange(me: MeResponse | undefined): boolean {
  return me?.user.mustChangePassword === true;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CredentialsInput) => apiSend<AuthUser>('POST', '/auth/login', input),
    onSuccess: () => {
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
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['setup-state'] });
    },
  });
}

/**
 * 改密。首次强制改密与主动改密走同一个接口。
 *
 * 成功后必须重取 `me` —— `mustChangePassword` 在服务端翻转成 false 了,
 * 不重取的话前端会一直卡在改密页上。
 */
export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      apiSend<void>('POST', '/auth/change-password', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
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
