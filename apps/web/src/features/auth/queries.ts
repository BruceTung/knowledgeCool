/**
 * 认证相关的服务端状态(DESIGN.md §7.3:服务端状态交给 TanStack Query)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuthUser,
  CredentialsInput,
  MeResponse,
  SetupInput,
} from '@knowledgecool/shared';

import { ApiError, apiFetch, apiSend } from '../../lib/api';

export interface SetupState {
  required: boolean;
}

/**
 * 库中是否还没有用户。决定访问 `/` 时去引导页还是登录页。
 *
 * 这是个**公开接口**(§6.2 v1.4 新增),所以在未登录时也能拿到答案 ——
 * 否则前端只能靠「试着提交并接住 403」来判断该显示哪个页面。
 */
export function useSetupState() {
  return useQuery({
    queryKey: ['setup-state'],
    queryFn: () => apiFetch<SetupState>('/auth/setup-state'),
    retry: false,
  });
}

/**
 * 当前登录用户。
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

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CredentialsInput) => apiSend<AuthUser>('POST', '/auth/login', input),
    onSuccess: () => {
      // 登录改变了「我是谁」以及可见空间,两个缓存都要重取。
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['spaces'] });
      void queryClient.invalidateQueries({ queryKey: ['setup-state'] });
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupInput) => apiSend<AuthUser>('POST', '/auth/setup', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['setup-state'] });
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
