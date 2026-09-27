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

/**
 * 节点可见性(v2.12 新增)。
 *
 *   · `public`(默认)—— 所有登录用户都能读。与 v2.0 以来的行为完全一致,
 *     所以这个字段是**加法**,不是改语义:存量节点一律 public,没人会突然看不见东西。
 *   · `restricted` —— 只有「所有者链 + 读者名单 + 编辑被授权者」能读。
 *     **整棵子树继承**,后代无法放开(见 schema 里的说明)。
 */
export const NODE_VISIBILITIES = ['public', 'restricted'] as const;
export type NodeVisibility = (typeof NODE_VISIBILITIES)[number];

export function isNodeVisibility(value: unknown): value is NodeVisibility {
  return typeof value === 'string' && (NODE_VISIBILITIES as readonly string[]).includes(value);
}

/** 把库里读出的字符串收敛成合法可见性,未知值一律按 `public`。 */
export function toNodeVisibility(value: string | null | undefined): NodeVisibility {
  return isNodeVisibility(value) ? value : 'public';
}

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
  /** 可见性(v2.12)。前端据此画锁形图标 —— 但**不是安全边界**,服务端才是。 */
  visibility: NodeVisibility;
  /** 所有者 */
  ownerId: string;
  ownerName: string;
  /**
   * 这个节点上的**评论总数**(含回复),树上的角标。
   *
   * ⚠️ 它数的是"有几条评论",不是"有几个待解决问题" ——
   * 这个系统里没有"问题"这个概念(2026-09-27 用户明确纠正过一次)。
   */
  commentCount: number;
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
  /** 可见性(v2.12)。restricted 时,未授权的人连请求都读不到(404)。 */
  visibility: NodeVisibility;
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

/**
 * 批量移动(v2.14)。
 *
 * ⚠️ 只做**移动**,不做批量删除。移动是可逆的,而删除 v2.12 起不可恢复 ——
 * 批量删除的误操作代价与它的价值完全不成比例(要清一整块旧内容,删那个组就够了)。
 */
export interface BulkMoveNodesInput {
  /** 要移动的节点。服务端会去重、限个数,并**逐个校验权限**。 */
  nodeIds: string[];
  /** 目标父节点。批量移动一律追加到它的末尾 */
  newParentId: string;
}

export interface BulkMoveResult {
  /** 实际移动了几个 */
  moved: number;
  newParentId: string;
}

/** 一次最多移动多少个。给的是"整理目录"的量级,不是"搬迁整棵树"。 */
export const BULK_MOVE_MAX = 50;
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

/** 把树形打平后按父子关系重建 —— 前端消费用。 */
export interface FlatNode extends NodeSummary {
  children: FlatNode[];
}
