/**
 * 组织树的**键盘导航与可见顺序**(v2.14)—— 从 OrgTreePanel 里抽出来的纯逻辑。
 *
 * ## 为什么抽出来
 *
 * 这段逻辑原本写在组件的 onKeyDown 里。它有两个特点:
 *   1. **错了不会立刻报错**,只表现为「某个方向键没反应」或「跳错地方」,
 *      而键盘用户往往以为是自己操作不对,不会提 bug —— 于是能存在很久没人知道;
 *   2. 它**完全不依赖 DOM** —— 输入是「按了哪个键 + 当前节点在哪」,输出是「该做什么」。
 *
 * 于是写成纯函数,组件只负责执行动作。这样能直接用现有的 vitest 覆盖它
 * (纯逻辑、node 环境、不需要 jsdom —— 这是这个仓库对前端测试的一贯取舍)。
 *
 * 方向键约定(W3C APG 的 tree 模式):
 *   ↑ / ↓      前后一个**可见**节点
 *   →          展开;已展开则进第一个子节点
 *   ←          折叠;已折叠则回父节点
 *   Home/End   第一个 / 最后一个可见节点
 *   Enter      打开(导航)
 */

/** 只要这两个字段,所以不依赖 features/org 的类型(避免 lib 反向依赖 features)。 */
export interface TreeNavNode {
  id: string;
  children: readonly TreeNavNode[];
}

/** 树的可见顺序(只算展开的分支)+ 每个节点的父节点。 */
export interface TreeOrder {
  /** 当前**可见**的节点 id,自上而下 */
  ids: string[];
  /** 子 → 父。根节点不在表里 */
  parentOf: Map<string, string>;
}

/**
 * 算出可见顺序。
 *
 * 键盘上下移动走的就是这份顺序 —— 折叠起来的分支里的节点**不参与**,
 * 否则焦点会跳到一个用户根本看不见的节点上(屏幕阅读器不会念任何东西,
 * 看起来就像「按了没反应」)。
 */
export function treeOrder(
  nodes: readonly TreeNavNode[],
  isExpanded: (id: string) => boolean,
): TreeOrder {
  const ids: string[] = [];
  const parentOf = new Map<string, string>();

  const walk = (list: readonly TreeNavNode[], parentId: string | null): void => {
    for (const node of list) {
      ids.push(node.id);
      if (parentId !== null) parentOf.set(node.id, parentId);
      if (isExpanded(node.id) && node.children.length > 0) walk(node.children, node.id);
    }
  };

  walk(nodes, null);
  return { ids, parentOf };
}

/** 一次按键的上下文。全是「当前状态」,没有任何 DOM。 */
export interface TreeKeyContext {
  key: string;
  /** 当前聚焦的节点 */
  nodeId: string;
  /** 当前节点的子节点 id(空数组 = 叶子) */
  childIds: readonly string[];
  /** 可见顺序 */
  visibleIds: readonly string[];
  /** 当前节点的父节点 id,根节点为 undefined */
  parentId: string | undefined;
  /** 当前节点是否展开 */
  isExpanded: boolean;
}

/** 该做什么。组件按这个执行,自己不做判断。 */
export type TreeKeyAction =
  | { type: 'move'; to: string | undefined }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  | { type: 'open'; id: string }
  | { type: 'none' };

const NONE: TreeKeyAction = { type: 'none' };

export function resolveTreeKey(ctx: TreeKeyContext): TreeKeyAction {
  const index = ctx.visibleIds.indexOf(ctx.nodeId);
  const hasChildren = ctx.childIds.length > 0;

  switch (ctx.key) {
    case 'ArrowDown':
      return { type: 'move', to: ctx.visibleIds[index + 1] };
    case 'ArrowUp':
      return { type: 'move', to: ctx.visibleIds[index - 1] };

    case 'ArrowRight':
      // 已展开 → 进**第一个子节点**,而不是「可见顺序里的下一个」——
      // 后者在子节点也展开时会跳过一整层。
      if (hasChildren && !ctx.isExpanded) return { type: 'expand', id: ctx.nodeId };
      if (hasChildren) return { type: 'move', to: ctx.childIds[0] };
      return NONE;

    case 'ArrowLeft':
      if (hasChildren && ctx.isExpanded) return { type: 'collapse', id: ctx.nodeId };
      // 这一条是键盘用户「进得去出不来」的唯一出路:
      // 从根走到深处之后,没有它就只能一路 Tab 到页尾再绕回来。
      if (ctx.parentId !== undefined) return { type: 'move', to: ctx.parentId };
      return NONE;

    case 'Home':
      return { type: 'move', to: ctx.visibleIds[0] };
    case 'End':
      return { type: 'move', to: ctx.visibleIds.at(-1) };

    case 'Enter':
      return { type: 'open', id: ctx.nodeId };

    default:
      return NONE;
  }
}
