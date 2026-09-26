/**
 * 页面级评论的共享类型 —— 对应 DESIGN.md §8.4。
 *
 * ⚠️ 阶段一的评论**不锚定到文字**:没有 anchor 字段,只有"挂在这一页上"。
 * 原因见 DESIGN.md §9 的 M5 说明 —— 锚点绑在正文结构上,
 * 阶段二正文模型一改锚点全废。所以列刻意**不加**,
 * 免得后来人顺手实现一个"半锚定"版本。
 */

export const COMMENT_STATUSES = ['open', 'resolved'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export function isCommentStatus(value: unknown): value is CommentStatus {
  return typeof value === 'string' && (COMMENT_STATUSES as readonly string[]).includes(value);
}

/** 评论正文长度上限(与数据库列宽无关,是产品约束)。 */
export const COMMENT_BODY_MAX_LENGTH = 4000;

/** 评论作者的精简信息。 */
export interface CommentAuthor {
  id: string;
  name: string;
  avatarColor: string;
  /**
   * 已离职 —— 用户明确要求"离职人员在他留下的内容上也要标出来"(v2.2)。
   * 与节点一样:历史记录不抹掉,只在名字旁注明。
   */
  departed: boolean;
}

/** 一条评论。回复嵌在 `replies` 里 —— 阶段一只允许一层嵌套。 */
export interface CommentView {
  id: string;
  nodeId: string;
  parentId: string | null;
  author: CommentAuthor;
  body: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
  /** 当前用户能否把它标为已解决(自己的、或该节点的任一祖先所有者)。用于前端显示按钮。 */
  canResolve: boolean;
  canDelete: boolean;
  replies: CommentView[];
}

/** `GET /nodes/:id/comments` 的响应体。 */
export interface CommentListResponse {
  nodeId: string;
  /** 扁平总数(含回复),前端用于页面树角标。 */
  total: number;
  openCount: number;
  threads: CommentView[];
}

/** 发表评论或回复。 */
export interface CreateCommentInput {
  body: string;
  /** 非空即为回复。服务端会校验它属于同一页面,且不产生二层以上嵌套。 */
  parentId?: string | null;
}

/** 编辑正文 / 切换解决状态。 */
export interface UpdateCommentInput {
  body?: string;
  status?: CommentStatus;
}
