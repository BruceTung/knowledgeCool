/**
 * 节点 —— DESIGN.md §4。
 *
 * ⚠️ **v2.0 起空间与页面是同一种东西**:树上带标题、可挂子节点、可带正文的节点。
 * `kind` 只影响展示(图标 / 默认展开),**不影响权限判定** ——
 * 不要在权限代码里对 kind 做分支。
 *
 * 新旧概念对照:
 *   Page → Node          (表也由 pages 改名为 nodes)
 *   PageTreeResponse → NodeTreeResponse
 *   空间(space) → 一级节点,`kind = 'space'`
 */

export const NODE_KINDS = ['space', 'document'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATUSES = ['draft', 'published', 'archived'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === 'string' && (NODE_KINDS as readonly string[]).includes(value);
}

export function isNodeStatus(value: unknown): value is NodeStatus {
  return typeof value === 'string' && (NODE_STATUSES as readonly string[]).includes(value);
}

/** 把库里读出的字符串收敛成合法状态,未知值一律按 `published`。 */
export function toNodeStatus(value: string | null | undefined): NodeStatus {
  return isNodeStatus(value) ? value : 'published';
}

/** 树上的一个节点。列表与树都用它 —— 字段刻意保持最小。 */
export interface NodeSummary {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  position: number;
  depth: number;
  status: NodeStatus;
  /**
   * 乐观锁版本号。
   *
   * ⚠️ 必须出现在树上:前端拖拽排序要拿它当 `MoveNodeInput.version`。
   * 若让前端"拖之前先拉一次详情",两次读之间数据可能已经变了,
   * 结果是**拖拽静默落到错误位置**,而且不报错。
   */
  version: number;
  /** 所有者 */
  ownerId: string;
  ownerName: string;
  /** 未解决评论数(树上的角标) */
  openCommentCount: number;
}

/**
 * 整棵树。
 *
 * **不做权限过滤** —— 所有节点对所有登录用户可见(§5.3 规则一)。
 * 但会额外告诉前端「我哪些能改、哪些能管」,前端据此**隐藏**按钮。
 * ⚠️ 这只是体验,服务端仍是唯一裁判。
 */
export interface NodeTreeResponse {
  nodes: NodeSummary[];
  /** 我有编辑权的节点 id */
  editableNodeIds: string[];
  /** 我有管理权(可授权)的节点 id */
  manageableNodeIds: string[];
}

export interface NodeBreadcrumb {
  id: string;
  title: string;
}

export interface NodeDetail {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  depth: number;
  /** 乐观锁:结构操作要带上,冲突返回 409 */
  version: number;
  ownerId: string;
  ownerName: string;
  /** 所有者是否已离职 —— 前端在名字旁标注「已离职」(v2.2) */
  ownerDeparted: boolean;
  createdByName: string;
  /** 创建者是否已离职 —— 用户明确要求「在他自己创建的页面上也标记为离职」 */
  createdByDeparted: boolean;
  createdAt: string;
  updatedAt: string;
  breadcrumb: NodeBreadcrumb[];
  /** 我能否改 / 管 —— 前端用来决定按钮是否渲染 */
  canEdit: boolean;
  canManage: boolean;
}

export interface CreateNodeInput {
  /** null = 建在一级(部门层)。**组员只能建在自己所属的节点下**,校验在服务端。 */
  parentId: string | null;
  kind: NodeKind;
  title?: string;
}

export interface UpdateNodeInput {
  title?: string;
  status?: NodeStatus;
  version: number;
}

export interface MoveNodeInput {
  /** null = 移到一级 */
  newParentId: string | null;
  /**
   * 排到第几位(0 起)。省略 = 排到最后。
   *
   * 用位置而不是"排到某个兄弟之前",是因为前端拖拽时本来就知道自己落在第几格,
   * 而按 id 找前驱需要前端先算一遍,算错就会**静默落到错误位置**。
   */
  newPosition?: number;
  version: number;
}

/** 回收站条目。**只列被删子树的根** —— 子树整体恢复,逐条列没有意义。 */
export interface TrashItem {
  id: string;
  title: string;
  kind: NodeKind;
  /** 被删子树里的节点总数(含自身)。前端显示「含 N 个子节点」 */
  subtreeSize: number;
  deletedAt: string;
  deletedByName: string;
  /** 原父节点还在不在树上 —— 决定恢复时会挂回原位还是挂到顶层 */
  parentAlive: boolean;
}

/** 回收站保留策略 —— 界面用它告诉用户"东西会自己消失"(v2.4)。 */
export interface TrashPolicy {
  /** 保留天数。`0` 表示自动清理**已关闭** */
  retentionDays: number;
  /** 扫描间隔(小时)。`0` 表示关闭 */
  purgeIntervalHours: number;
}

/**
 * 回收站保留策略的执行结果(v2.4)。
 *
 * 这条策略的背景:回收站此前**不会自己清理** —— 删掉的东西一直留着,
 * 这既吃磁盘,也让"回收站里那些陈年条目还能恢复吗"变成一个说不清的问题。
 */
export interface TrashPurgeResult {
  /** 当前生效的保留天数。`0` 表示自动清理**已关闭** */
  retentionDays: number;
  /** 本次(或将)被清理的子树根。`dryRun` 时就靠它预览 */
  roots: { id: string; title: string; deletedAt: string; subtreeSize: number }[];
  /** 实际删除的节点数。`dryRun` 时恒为 `0` */
  purgedNodes: number;
}

/** 把树形打平后按父子关系重建 —— 前端消费用。 */
export interface FlatNode extends NodeSummary {
  children: FlatNode[];
}
