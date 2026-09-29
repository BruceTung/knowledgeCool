/**
 * 组织树的查询与变更(DESIGN.md §6.2 的「节点」一组)。
 *
 * 缓存键的约定:
 *   `['org','tree']`      整棵树(全员可读,一次拿全量)
 *   `['node', id]`        单节点详情
 *   `['node', id,'content']` 正文
 *   `['node', id,'...']`  评论 / 授权
 *
 * 变更后一律 invalidate 树 + 该节点 —— **不手改缓存**。
 * 树的 `editableNodeIds` 是服务端算的,本地推不出来;手改必然漂移,
 * 表现是"刚建的页面没有新建按钮"这类难查的小毛病。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkMoveNodesInput,
  BulkMoveResult,
  CreateNodeInput,
  MoveNodeInput,
  NodeContentResponse,
  NodeDetail,
  NodeTreeResponse,
  SaveContentInput,
  UpdateNodeInput,
} from '@knowledgecool/shared';

import { apiDownload, apiFetch, apiSend } from '../../lib/api';

export function useOrgTree() {
  return useQuery({
    queryKey: ['org', 'tree'],
    queryFn: () => apiFetch<NodeTreeResponse>('/org/tree'),
    // 树是全局共享的:整站导航都靠它,别让它在每次窗口聚焦时重拉
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  });
}

export function useNodeDetail(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId ?? ''],
    queryFn: () => apiFetch<NodeDetail>(`/nodes/${String(nodeId)}`),
    enabled: nodeId !== undefined && nodeId !== '',
  });
}

export function useNodeContent(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId ?? '', 'content'],
    queryFn: () => apiFetch<NodeContentResponse>(`/nodes/${String(nodeId)}/content`),
    enabled: nodeId !== undefined && nodeId !== '',
    // 正文的冲突检测靠客户端带回 baseUpdatedAt,不需要 react-query 顺手重拉 ——
    // 那种自动刷新会把正在打字的人的光标顶走、输入被吞。
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

/** 变更成功后要刷新哪些东西。 */
function useInvalidateTree() {
  const queryClient = useQueryClient();
  return (nodeId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['org', 'tree'] });
    if (nodeId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: ['node', nodeId] });
    }
  };
}

export function useCreateNode() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (input: CreateNodeInput) => apiSend<NodeDetail>('POST', '/nodes', input),
    onSuccess: (created) => {
      invalidate(created.id);
    },
  });
}

export function useUpdateNode() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (vars: { nodeId: string } & UpdateNodeInput) =>
      apiSend<NodeDetail>('PATCH', `/nodes/${vars.nodeId}`, {
        ...(vars.title === undefined ? {} : { title: vars.title }),
        ...(vars.status === undefined ? {} : { status: vars.status }),
        version: vars.version,
      } satisfies UpdateNodeInput),
    onSuccess: (_detail, vars) => {
      invalidate(vars.nodeId);
    },
  });
}

export function useMoveNode() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (vars: { nodeId: string } & MoveNodeInput) =>
      apiSend<NodeDetail>('POST', `/nodes/${vars.nodeId}/move`, {
        newParentId: vars.newParentId,
        ...(vars.newPosition === undefined ? {} : { newPosition: vars.newPosition }),
        version: vars.version,
      } satisfies MoveNodeInput),
    onSuccess: (_detail, vars) => {
      invalidate(vars.nodeId);
    },
  });
}

/**
 * 批量移动(v2.14)。
 *
 * ⚠️ 成功后要失效**每一个**被移动节点 —— 手改缓存不行:
 * 树的 `editableNodeIds` 是服务端算的,而路径变了会连带影响祖先链判定,
 * 本地推不出来(与 useInvalidateTree 顶部那条注释同一个理由)。
 */
export function useBulkMoveNodes() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (input: BulkMoveNodesInput) =>
      apiSend<BulkMoveResult>('POST', '/nodes/bulk/move', input),
    onSuccess: (_result, input) => {
      for (const nodeId of input.nodeIds) invalidate(nodeId);
      // 目标本身也要失效:它的子节点列表变了
      invalidate(input.newParentId);
    },
  });
}

export function useDeleteNode() {
  const invalidate = useInvalidateTree();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) =>
      apiSend<{ removedCount: number }>('DELETE', `/nodes/${nodeId}`),
    onSuccess: (_result, nodeId) => {
      invalidate(nodeId);
      /*
        ⚠️ v2.16:删除后要**移除**这个节点的查询缓存,不能只 invalidate。

        两个原因:
          · 后端是**物理删除**(§8.2),这个 id 不会再出现,留着必然是垃圾;
          · 正文那条查询的 `staleTime` 是 `Infinity`(为了不打断正在打字的人),
            单纯 invalidate 不会让一条"永不陈旧"的缓存消失 ——
            它要一直留到刷新页面为止。用浏览器后退回到那个路径时,
            详情会 404 挡住(所以看不出错),但缓存本身就那么挂着。
        删除是少数几个**明确知道数据不会再回来**的时机,这时移除是对的。
      */
      queryClient.removeQueries({ queryKey: ['node', nodeId] });
    },
  });
}

/**
 * 保存正文。
 *
 * 成功后**只更新缓存里的时间戳,不 invalidate** —— invalidate 会触发重新拉取,
 * 把编辑器里的内容重置一遍。而用户可能刚好在那几百毫秒里又改了字。
 */
export function useSaveContent(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveContentInput) =>
      apiSend<NodeContentResponse>('PUT', `/nodes/${nodeId}/content`, input),
    onSuccess: (saved) => {
      queryClient.setQueryData<NodeContentResponse>(['node', nodeId, 'content'], saved);
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      void queryClient.invalidateQueries({ queryKey: ['node', nodeId] });
    },
  });
}

/** 导出为 Markdown 并触发下载。 */
export function useExportMarkdown() {
  return useMutation({
    mutationFn: (vars: { nodeId: string; title: string }) =>
      apiDownload(`/nodes/${vars.nodeId}/export?format=md`, `${vars.title || 'document'}.md`),
  });
}
