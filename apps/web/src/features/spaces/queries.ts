/**
 * 空间与成员的服务端状态(DESIGN.md §7.3:服务端状态交给 TanStack Query)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddSpaceMemberInput,
  CreateSpaceInput,
  SpaceMemberView,
  SpaceMembersResponse,
  SpaceRole,
  SpaceSummary,
} from '@knowledgecool/shared';

import { apiFetch, apiSend } from '../../lib/api';

export function useSpaces() {
  return useQuery({
    queryKey: ['spaces'],
    queryFn: () => apiFetch<SpaceSummary[]>('/spaces'),
  });
}

export function useCreateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSpaceInput) => apiSend<SpaceSummary>('POST', '/spaces', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['spaces'] });
      // /auth/me 也带空间列表(左侧导航用它),同样要刷新。
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useMembers(spaceId: string | undefined) {
  return useQuery({
    queryKey: ['spaces', spaceId, 'members'],
    queryFn: () => apiFetch<SpaceMembersResponse>(`/spaces/${String(spaceId)}/members`),
    // spaceId 从路由参数来,理论上可能为空(URL 被手改)。此时不要发请求。
    enabled: spaceId !== undefined && spaceId !== '',
  });
}

/** 成员变动都会改成员数,顺手把空间列表也失效掉。 */
function useInvalidateMembers(spaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['spaces', spaceId, 'members'] });
    void queryClient.invalidateQueries({ queryKey: ['spaces'] });
  };
}

export function useAddMember(spaceId: string) {
  const invalidate = useInvalidateMembers(spaceId);
  return useMutation({
    mutationFn: (input: AddSpaceMemberInput) =>
      apiSend<SpaceMemberView>('POST', `/spaces/${spaceId}/members`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateMemberRole(spaceId: string) {
  const invalidate = useInvalidateMembers(spaceId);
  return useMutation({
    mutationFn: (vars: { userId: string; role: SpaceRole }) =>
      apiSend<SpaceMemberView>('PATCH', `/spaces/${spaceId}/members/${vars.userId}`, {
        role: vars.role,
      }),
    onSuccess: invalidate,
  });
}

export function useRemoveMember(spaceId: string) {
  const invalidate = useInvalidateMembers(spaceId);
  return useMutation({
    mutationFn: (userId: string) =>
      apiSend<void>('DELETE', `/spaces/${spaceId}/members/${userId}`),
    onSuccess: invalidate,
  });
}
