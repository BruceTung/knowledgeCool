/**
 * 批量移动的**选择整理**(v2.14)—— 纯函数,可测。
 *
 * ## 为什么需要它
 *
 * 服务端有一条规则:**批量里不允许出现互为祖先的节点**
 * (选了 A 又选它里面的 B 时,结果取决于执行顺序,不可预测 —— 见 bulkMove 的说明)。
 *
 * 那条规则必须留在服务端(它是安全与正确性的底线)。但**只靠它**的话,
 * 用户会撞上一个报错才知道自己选错了,而且要自己去想"哪个在哪个里面"。
 * 这里做两件事:
 *   1. 提前算出"该拒"的选择,让界面能解释原因,而不是等服务端打回来;
 *   2. 算出哪些节点可以当目标(排除会成环的那些),目标下拉里就不该出现它们。
 *
 * ⚠️ 它**不是**安全边界 —— 服务端照样全查一遍。这里只是把体验做对。
 */

import type { OrgTreeNode } from '../features/org/tree-utils';
import { findNode, isInsideSubtree } from '../features/org/tree-utils';

export interface SelectionTidy {
  /** 实际会提交的节点(已去掉"被别的选中项包含"的那些) */
  kept: string[];
  /** 被去掉的,连带原因 —— 界面要**明说**,不能静默改用户的选择 */
  dropped: { id: string; title: string; reason: string }[];
}

/**
 * 整理选择:只保留**最外层**的那几个。
 *
 * ⚠️ 被去掉的必须回传并在界面上说出来。静默缩小用户的选择是最糟的处理方式 ——
 * 他会以为系统自作主张("我明明勾了 5 个,怎么只动了 2 个")。
 */
export function tidySelection(
  nodes: readonly OrgTreeNode[],
  selectedIds: readonly string[],
): SelectionTidy {
  const kept: string[] = [];
  const dropped: { id: string; title: string; reason: string }[] = [];

  for (const id of selectedIds) {
    // ⚠️ 要跟**全部**选中项比,不能只跟"已经留在 kept 里的"比。
    // 我第一版就是只比 kept,于是先处理里面的、再处理外面的时,
    // 外面的那个进来时里面那个**已经在 kept 里了**,而它不会去反查
    // "我是它的祖先吗" —— 结果两个都被留下,而且**取决于勾选的顺序**。
    // 这正是这个函数存在的理由(顺序无关),却被我自己写反了。
    // 用例「顺序无关:先选里面的再选外面的,结果一样」抓到了它。
    const container = selectedIds.find(
      (other) => other !== id && isInsideSubtree(nodes, other, id),
    );
    if (container === undefined) {
      kept.push(id);
      continue;
    }
    const parentTitle = findNode(nodes, container)?.title ?? container;
    dropped.push({
      id,
      title: findNode(nodes, id)?.title ?? id,
      reason: `它已经在「${parentTitle}」里面了,会跟着一起移动`,
    });
  }

  return { kept, dropped };
}

/**
 * 可当目标的节点。
 *
 * 排除三类,每一类都会让服务端拒绝(或产生荒谬的结果):
 *   · 选中项自己 —— 移到自己是无意义的;
 *   · 选中项的**子孙** —— 会成环(树的路径会自引用);
 *   · 非 space 节点(文档不能当父节点)。
 *
 * 另外排除选中项的**祖先**吗?不排除 —— 把子节点移到父节点下是"归位",
 * 完全合理(拖拽排序就是这个语义)。
 */
export function destinationCandidates(
  nodes: readonly OrgTreeNode[],
  selectedIds: readonly string[],
): OrgTreeNode[] {
  const out: OrgTreeNode[] = [];

  const walk = (list: readonly OrgTreeNode[]): void => {
    for (const node of list) {
      if (node.kind === 'space' && !selectedIds.includes(node.id)) {
        const wouldCycle = selectedIds.some(
          (selected) => node.id === selected || isInsideSubtree(nodes, selected, node.id),
        );
        if (!wouldCycle) out.push(node);
      }
      walk(node.children);
    }
  };

  walk(nodes);
  return out;
}

/** 面包屑式的路径,给目标下拉用(重名的组在一长串下拉里分不出来)。 */
export function pathLabel(nodes: readonly OrgTreeNode[], nodeId: string): string {
  const parts: string[] = [];
  let cursor = findNode(nodes, nodeId);
  while (cursor !== undefined) {
    parts.unshift(cursor.title);
    const parentId = cursor.parentId;
    cursor = parentId === null ? undefined : findNode(nodes, parentId);
  }
  return parts.join(' / ');
}
