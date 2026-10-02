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

/*
  ⚠️ v4.22:关于「`staleTime: Infinity` 会不会让人切走再切回看到旧正文」——
  **实测答案:不会,这条不需要改。** 记录在此,免得下次有人照着重查一遍。

  当初的担心是:`PageEditor` 的卸载补保存是 fire-and-forget
  (`void flushRef.current(…)`),组件当场卸载;若用户在响应回来**之前**就切回来,
  缓存里还是旧正文,而 `staleTime: Infinity` 让它被当成「新鲜」→ 不重拉 → 显示旧内容。

  实测三条,都不成立:
    1. 打字 → 切到另一个节点 → 切回目标节点:内容在约 600ms 内正确出现;
    2. **变异对照**:把 `refetchOnMount: 'always'` 加进去再拿掉,行为**完全一样**
       —— 也就是说加它对可观察行为毫无影响(所以没有采纳);
    3. **绕过前端**直接经接口改服务端内容(模拟「beacon 写了库但缓存不知道」),
       再切走切回 → 编辑器显示的是**服务端最新的**内容。

  第 3 条解释了为什么:`staleTime` 决定「多久算旧」,但**新挂载的 observer 没有缓存数据时
  仍会去拉**;而切走时组件卸载、query 变为非活跃,回来后属于重新取数路径,
  并不是「拿一份 fresh 缓存直接用」。

  ⚠️ **顺便记一个测试教训**:本轮一开始用 `history.back()` 复现,连续三次「复现成功」都是假的 ——
  `history.back()` 回到了**另一条历史记录**(另一个节点),而我读的是那个页面的空编辑器。
  换成「显式导航回目标节点」后,三条全部通过。**「复现」也要验证自己复现的是不是那件事。**
*/

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
    mutationFn: (nodeId: string) => apiSend<{ removedCount: number }>('DELETE', `/nodes/${nodeId}`),
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
 *
 * ⚠️⚠️ **写入缓存前必须比 `updatedAt`,不能无条件覆盖**(v4.8 修)。
 *
 * 编辑器的自动保存是**串行**的,但一次慢保存期间用户又改字时,界面会再发一次
 * —— 两次请求在网络上会**交错返回**:先发的后回来时,它带的是**旧正文**
 * 与**旧 `updatedAt`**,而无条件 `setQueryData` 会把它盖在新响应上面。
 * 后果有两个,而且都不像"缓存问题":
 *   1. 组件重新挂载时拿到**旧正文**(用户以为自己改丢了);
 *   2. 同时拿到**旧 `baseUpdatedAt`** —— 下一次保存拿它当乐观锁基线,
 *      服务端一比对就报 409,界面显示"别人改过这篇文档"。
 *      而实际上根本没有别人,是本地两次保存自己把基线写回去了,属于**假冲突**。
 *
 * 比较用 ISO 字符串直接比大小即可:服务端一律返回 `toISOString()`,
 * 同一格式下的字典序与时间序一致(仓库里其它地方也用同一手法)。
 * 相等时保留现有值(内容必然相同,省一次无意义的对象替换)。
 */
export function useSaveContent(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveContentInput) =>
      apiSend<NodeContentResponse>('PUT', `/nodes/${nodeId}/content`, input),
    onSuccess: (saved) => {
      queryClient.setQueryData<NodeContentResponse>(['node', nodeId, 'content'], (prev) => {
        if (prev !== undefined && prev.updatedAt > saved.updatedAt) return prev;
        return saved;
      });
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
