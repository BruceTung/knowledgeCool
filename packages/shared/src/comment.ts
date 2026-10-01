/**
 * 页面级评论的共享类型 —— 对应 DESIGN.md §5.4。
 *
 * ⚠️ 阶段一的评论**不锚定到文字**:没有 anchor 字段,只有"挂在这一页上"。
 * 原因见 DESIGN.md §10 硬约束 1 —— 锚点绑在正文结构上,
 * 阶段二正文模型一改锚点全废。所以列刻意**不加**,
 * 免得后来人顺手实现一个"半锚定"版本。
 *
 * ⚠️ **评论就是评论,不是"问题单"。**(2026-09-27 用户明确纠正)
 *
 * 此前这里有一套 `open` / `resolved` 状态,界面上表现为「标记已解决」按钮
 * 与节点树上的「未解决评论」角标 —— 那等于把评论当缺陷跟踪用。
 * 用户的原话是:「评论只是评论,不是问题,你不要擅自赋予评论额外的含义」。
 *
 * 那套语义已**整体移除**(连数据库列一起),角标改为显示**评论总数**。
 * 不要再以"将来可能会用"为理由把状态字段加回来 —— 一个没人要求的状态机
 * 会让每条评论都背上"它解决了没有"这个问题。
 */

/** 评论正文长度上限(与数据库列宽无关,是产品约束)。 */
export const COMMENT_BODY_MAX_LENGTH = 4000;

/** 评论作者的精简信息。 */
export interface CommentAuthor {
  id: string;
  name: string;
  avatarColor: string;
  /**
   * 已离职 —— 离职人员在他留下的内容上也要标出来(v2.2)。
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
  createdAt: string;
  updatedAt: string;
  /**
   * 我能否改这条的正文 —— **只有作者本人**。
   *
   * ⚠️ 它和 `canDelete` 不是一回事:该节点的所有者能删别人的评论(属于版务),
   * 但**不能改**(改别人的话是篡改他人言论)。
   * 之前界面上两个按钮共用一个 `canDelete`,结果是所有者能看到「编辑」按钮、
   * 点了却 403。分开之后按钮与服务端的判定才一致。
   */
  canEdit: boolean;
  /** 我能否删这条 —— 作者本人,或该节点的任一级所有者。 */
  canDelete: boolean;
  replies: CommentView[];
}

/** `GET /nodes/:id/comments` 的响应体。 */
export interface CommentListResponse {
  nodeId: string;
  /** 扁平总数(含回复),前端用于节点树角标。 */
  total: number;
  threads: CommentView[];
}

/** 发表评论或回复。 */
export interface CreateCommentInput {
  body: string;
  /** 非空即为回复。服务端会校验它属于同一页面,且不产生二层以上嵌套。 */
  parentId?: string | null;
}

/** 编辑评论正文。 */
export interface UpdateCommentInput {
  body: string;
}
