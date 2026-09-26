/**
 * 页面树的纯逻辑工具。
 *
 * 单独抽出来是为了能被测:拖拽的合法性判定(不能把节点拖进自己的子树)
 * 一旦写错,树会成环,而物化路径成环之后所有前缀查询都会失效 ——
 * 这类错误在界面上只表现为「有时候拖不动」,极难定位。
 */
import type { PageNode } from '@knowledgecool/shared';

/** 深度优先按 id 找节点。 */
export function findNode(nodes: readonly PageNode[], id: string): PageNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * `candidateId` 是否落在「以 `ancestorId` 为根的子树」**内部**
 * (不含 `ancestorId` 自身 —— 自身相等由调用方单独判)。
 *
 * 拖拽时用它拦掉非法目标。把父节点拖进自己的子孙会让树成环。
 */
export function isInsideSubtree(
  nodes: readonly PageNode[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const ancestor = findNode(nodes, ancestorId);
  if (ancestor === undefined) return false;
  return findNode(ancestor.children, candidateId) !== undefined;
}

export interface NodeLocation {
  /** 父节点 id;根节点为 null。 */
  parentId: string | null;
  /** 在兄弟中的下标(按 position 升序后)。 */
  index: number;
}

/**
 * 定位节点在树里的父与下标。
 *
 * 拖拽落位要用它把「拖到某个节点前面/后面」翻译成「目标父 + 目标下标」——
 * 服务端的 move 接口只认这两样,不认「兄弟关系」。
 */
export function locateNode(nodes: readonly PageNode[], id: string): NodeLocation | undefined {
  const walk = (
    list: readonly PageNode[],
    parentId: string | null,
  ): NodeLocation | undefined => {
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      if (node === undefined) continue;
      if (node.id === id) return { parentId, index };
      const hit = walk(node.children, node.id);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(nodes, null);
}

/**
 * 首次进入时默认展开哪些节点:前两层里有子节点的那些。
 *
 * 全展开会让长树一屏放不下,全折叠又看不出结构 —— 折中在前两层。
 */
export function defaultExpandedIds(nodes: readonly PageNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly PageNode[]): void => {
    for (const node of list) {
      if (node.children.length === 0) continue;
      if (node.depth <= 1) ids.push(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

/** 展开到达某个节点的整条路径 —— 从别处跳进来时保证它可见。 */
export function expandedIdsFor(nodes: readonly PageNode[], pageId: string): string[] {
  const path: string[] = [];
  const walk = (list: readonly PageNode[], trail: string[]): boolean => {
    for (const node of list) {
      if (node.id === pageId) {
        path.push(...trail);
        return true;
      }
      if (node.children.length > 0 && walk(node.children, [...trail, node.id])) return true;
    }
    return false;
  };
  walk(nodes, []);
  return path;
}

/** 树里的页面总数。用于空状态与统计展示。 */
export function countPages(nodes: readonly PageNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countPages(node.children);
  return total;
}
