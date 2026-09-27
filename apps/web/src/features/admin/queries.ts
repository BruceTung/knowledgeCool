/**
 * 组织架构与人员的管理侧查询(超管 / 部长)。
 *
 * 这一组对应 §6.2 的「组织架构」与「导入」两组接口。**大部分是超管专属**:
 * 建部门、建人、设归属、导入 —— 组织架构是管理层的事。
 * 例外是「任命组长」:部长就能做(`PATCH /nodes/:id/owner`)。
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateUserInput,
  GrantCandidate,
  OrgImportResponse,
  OrgScopeOption,
  OrgUserListResponse,
  OrgUserView,
  SetUserAssignmentsInput,
  UpdateUserInput,
} from '@knowledgecool/shared';

import { apiDownload, apiFetch, apiSend, apiUpload } from '../../lib/api';

export function useOrgScopes() {
  return useQuery({
    queryKey: ['org', 'scopes'],
    queryFn: () => apiFetch<OrgScopeOption[]>('/org/scopes'),
  });
}

/**
 * 人员列表 —— **分页**。
 *
 * ⚠️ 改成包装对象是为了修一个静默截断:此前服务端 `take: 200` 一截了事,
 * 全公司 320 人时管理员只看到 200 个而界面上没有任何迹象。
 * 现在前端拿得到 `total`,能判断出"我没看到全部"。
 *
 * 用 `useInfiniteQuery` 而不是手写 page 状态:翻页时要**追加**而不是替换,
 * 手写一个 `pages` 数组很容易在搜索词变化时忘了清空 —— 表现是搜索"张"之后
 * 第一页却混着上一次的结果。
 *
 * @param limit 每页条数。下拉选择器用它一次要全(500),表格用默认的 50。
 */
export function useOrgUsers(query: string, limit?: number) {
  const trimmed = query.trim();
  const size = limit === undefined ? '' : `&limit=${String(limit)}`;

  const infinite = useInfiniteQuery({
    queryKey: ['org', 'users', trimmed, limit ?? 'default'],
    queryFn: ({ pageParam }) =>
      apiFetch<OrgUserListResponse>(
        `/admin/users?q=${encodeURIComponent(trimmed)}${size}` +
          (pageParam === '' ? '' : `&cursor=${encodeURIComponent(pageParam)}`),
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const users = (infinite.data?.pages ?? []).flatMap((page) => page.users);
  const total = infinite.data?.pages[0]?.total ?? 0;

  return {
    users,
    total,
    /** 还有没加载的页 */
    hasMore: infinite.hasNextPage,
    /** 是否被 limit 截断了(下拉选择器这种"一次要全"的场景用) */
    truncated: total > users.length,
    isPending: infinite.isPending,
    isError: infinite.isError,
    error: infinite.error,
    isFetchingNextPage: infinite.isFetchingNextPage,
    // 暴露 refetch:错误提示上的「重试」要用它。少了它,用户唯一的出路是刷新整页。
    refetch: infinite.refetch,
    loadMore: () => {
      void infinite.fetchNextPage();
    },
  };
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => apiSend<OrgUserView>('POST', '/admin/users', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userId: string } & UpdateUserInput) =>
      apiSend<OrgUserView>('PATCH', `/admin/users/${vars.userId}`, {
        ...(vars.name === undefined ? {} : { name: vars.name }),
        ...(vars.status === undefined ? {} : { status: vars.status }),
      } satisfies UpdateUserInput),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

export function useSetUserAssignments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userId: string } & SetUserAssignmentsInput) =>
      apiSend<OrgUserView>('PATCH', `/admin/users/${vars.userId}/assignments`, {
        nodeIds: vars.nodeIds,
      } satisfies SetUserAssignmentsInput),
    onSuccess: () => {
      // 归属变了 → 树的 editable/manageable 标记跟着变
      void queryClient.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

/**
 * 把某人的密码重置为内置初始密码(超管)。
 *
 * 服务端会**顺带吊销他全部会话**,所以这个动作不只是"改个密码" ——
 * 它会把那个人立刻踢下线,他正在编辑但没保存的内容会丢。
 * 调用方必须先确认(见 `UsersAdminPage`)。
 */
export function useResetUserPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiSend<OrgUserView>('POST', `/admin/users/${userId}/reset-password`, {}),
    onSuccess: () => {
      // 列表上那个「初始密码未改」标记要跟着变 —— 它就是这个接口的效果
      void queryClient.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

/** 建部门(一级,超管)或建组(二级,部长)。 */
export function useCreateOrgNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; parentId: string | null; ownerId?: string }) =>
      apiSend<{ id: string; title: string }>('POST', '/org/nodes', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org'] });
    },
  });
}

export function useOwnerCandidates(nodeId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'owner-candidates'],
    queryFn: () => apiFetch<GrantCandidate[]>(`/nodes/${String(nodeId)}/owner-candidates`),
    enabled: enabled && nodeId !== undefined && nodeId !== '',
  });
}

export function useSetOwner(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ownerId: string) =>
      apiSend<void>('PATCH', `/nodes/${nodeId}/owner`, { ownerId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org'] });
      void queryClient.invalidateQueries({ queryKey: ['node', nodeId] });
    },
  });
}

// ---------------- Excel 导入(§8.5) ----------------

export function useImportTemplate() {
  return useMutation({
    mutationFn: () => apiDownload('/admin/org/import-template', '组织架构导入模板.xlsx'),
  });
}

/**
 * 上传并预览 / 确认写入。**同一个接口的两个模式**,保证预览与实际写入
 * 走的是同一份解析逻辑。
 *
 * 确认写入时必须带上预览返回的 `contentHash` —— 服务端用它确认
 * "你确认的就是你刚才看过的那一份"。
 */
export function useImportOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { file: File; dryRun: boolean; contentHash?: string }) => {
      const params = new URLSearchParams({ dryRun: String(vars.dryRun) });
      if (vars.contentHash !== undefined) params.set('contentHash', vars.contentHash);
      return apiUpload<OrgImportResponse>(`/admin/org/import?${params.toString()}`, vars.file);
    },
    onSuccess: (result) => {
      // 预览不动数据,不用刷新;确认写入之后才刷
      if (result.applied !== null) void queryClient.invalidateQueries({ queryKey: ['org'] });
    },
  });
}
