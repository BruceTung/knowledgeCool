/**
 * 组织树的纯逻辑工具。
 *
 * 单独抽出来是为了能被测:拖拽合法性(不能把节点拖进自己的子树)一旦写错,
 * 树会成环,而物化路径成环之后所有前缀查询都会失效 —— 界面上只表现为
 * 「有时候拖不动」,极难定位。
 *
 * ⚠️ **深度不设上限**:一级=部门、二级=组/项目是**组织形态**,再往下是
 * 使用者自己建的内容,技术上必须允许无限嵌套(用户明确要求)。
 * 所以这里所有函数都必须是真正的递归,不能只写两层。
 */
import type { NodeSummary } from '@knowledgecool/shared';

export interface OrgTreeNode extends NodeSummary {
  children: OrgTreeNode[];
}

/**
 * 扁平列表 → 嵌套树。
 *
 * 服务端给的是**扁平数组**(带 `parentId`),不是嵌套结构 —— 因为扁平的
 * 传输体更小、也更容易做「一次性按 position 排序」。这里重建嵌套。
 *
 * ⚠️ 父节点不在列表里的情况(被权限裁掉、或数据异常)要**当成顶层**处理,
 * 否则那个节点会在树上凭空消失 —— 而"东西不见了"比"位置不对"更难排查。
 */
export function buildTree(nodes: readonly NodeSummary[]): OrgTreeNode[] {
  const byId = new Map<string, OrgTreeNode>();
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });

  const roots: OrgTreeNode[] = [];
  for (const node of nodes) {
    const self = byId.get(node.id);
    if (self === undefined) continue;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (parent === undefined) {
      roots.push(self);
    } else {
      parent.children.push(self);
    }
  }

  const sort = (list: OrgTreeNode[]): void => {
    list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    for (const item of list) sort(item.children);
  };
  sort(roots);

  return roots;
}

/** 深度优先按 id 找节点。 */
export function findNode(nodes: readonly OrgTreeNode[], id: string): OrgTreeNode | undefined {
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
 */
export function isInsideSubtree(
  nodes: readonly OrgTreeNode[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const ancestor = findNode(nodes, ancestorId);
  if (ancestor === undefined) return false;
  return findNode(ancestor.children, candidateId) !== undefined;
}

export interface NodeLocation {
  parentId: string | null;
  /** 在兄弟中的下标(已按 position 排序) */
  index: number;
}

/**
 * 定位节点在树里的父与下标。
 *
 * 拖拽落位要用它把「落在第几格」翻译成「目标父 + 目标下标」——
 * `POST /nodes/:id/move` 只认这两样,不认"兄弟关系"。
 */
export function locateNode(nodes: readonly OrgTreeNode[], id: string): NodeLocation | undefined {
  const walk = (
    list: readonly OrgTreeNode[],
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
 * 首次进入时默认展开哪些:**一级(部门)**。
 *
 * 全展开会让长树一屏放不下;全折叠又看不出公司有哪些部门。
 * 展开到部门这一层正好回答"公司有哪些部门"。
 */
export function defaultExpandedIds(nodes: readonly OrgTreeNode[]): string[] {
  return nodes.filter((node) => node.children.length > 0).map((node) => node.id);
}

/** 展开到达某个节点的整条路径 —— 从别处(检索结果、直接改 URL)跳进来时保证它可见。 */
export function expandedIdsFor(nodes: readonly OrgTreeNode[], nodeId: string): string[] {
  const walk = (list: readonly OrgTreeNode[], trail: string[]): string[] | undefined => {
    for (const node of list) {
      if (node.id === nodeId) return trail;
      if (node.children.length > 0) {
        const hit = walk(node.children, [...trail, node.id]);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(nodes, []) ?? [];
}

/** 树里的节点总数。用于空状态与统计展示。 */
export function countNodes(nodes: readonly OrgTreeNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countNodes(node.children);
  return total;
}

/**
 * 一棵子树里的节点总数(含自身)。
 * 删除确认要显示「含 N 个子节点」,数字必须对得上。
 */
export function subtreeSize(node: OrgTreeNode): number {
  return 1 + countNodes(node.children);
}
