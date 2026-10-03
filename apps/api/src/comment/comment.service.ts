/**
 * 评论服务(DESIGN.md §5.4)。
 *
 * ⚠️ **v2.0 的两处变化:**
 *   1. `pageId` → `nodeId` —— 空间与页面已合并为节点树
 *   2. **全员可评论** —— 读既然对所有登录用户开放,留言就不该再设门槛。
 *      旧的 `commenter` 角色在新模型里根本不存在。
 *
 * 不变的三条边界(刻意画死):
 *   - **不锚定到文字**:没有 anchor 字段。锚点绑在正文结构上,阶段二正文模型一动锚点全废。
 *   - **只有一层回复**:`parentId` 指向的那条必须自己也是顶层评论。
 *   - **不发任何通知**:用户靠节点树上的角标知道有新评论。
 *
 * ## 谁能做什么(§5.4)
 *
 * | 动作 | 门槛 |
 * |---|---|
 * | 看评论 | 全员 |
 * | 发表 / 回复 | **全员** |
 * | 改评论正文 | **只有作者本人** —— 编辑别人的话是篡改他人言论 |
 * | 删除 | 作者本人,或该节点的**任一祖先所有者** |
 *
 * ⚠️ **这里没有"已解决"。**
 *
 * 评论不是问题单。此前那一套 `open` / `resolved` 状态(以及"标记已解决"按钮、
 * 节点树上的"未解决"角标)已整体移除,连数据库列一起 ——
 * 用户明确纠正过:「评论只是评论,不是问题,你不要擅自赋予评论额外的含义」。
 * 不要再以"将来可能会用"为理由加回来。
 */

import { Injectable } from '@nestjs/common';
import {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_THREADS_MAX,
  type Actor,
  type CommentListResponse,
  type CommentView,
  type CreateCommentInput,
  type UpdateCommentInput,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../permission/permission.service.js';

const COMMENT_SELECT = {
  id: true,
  nodeId: true,
  parentId: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  user: { select: { id: true, name: true, avatarColor: true, status: true } },
} satisfies Prisma.CommentSelect;

type CommentRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>;

@Injectable()
export class CommentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * 节点的评论列表。顶层评论按时间正序,回复挂在各自的 `replies` 下。
   *
   * v2.12 起**要过读判定** —— 受限节点的评论也不该被未授权的人看到。
   * (评论正文常常比文档本身更直白,漏掉这一条等于保密只做了一半。)
   *
   * ⚠️ v5.43 加了**上限**(P2-2)。原来这里 `findMany` 不带 `take`,
   * 于是"一页要渲染多少条评论"完全取决于数据 —— 正常时是几条,
   * 吵起来就是几百条,每个都要查作者、判权限、再序列化成 JSON。
   *
   * 两条刻意的取舍:
   *   1. **只截顶层,回复跟着走。** 阶段一只允许一层嵌套(P2 见 `create`),
   *      顶层取前 N 条、再按这 N 条的 id 取回复,一个回复都不会落到截断之外。
   *      若先对全量扁平结果 `take`,会出现"顶层在、回复没了"的残缺对话。
   *   2. **`total` 仍是全量计数**,不含回复也只有这 N 条的 visible 部分 ——
   *      它是节点树角标的依据,截断它会让角标说谎。
   *      顺带一个查询换来"上限不是新的信息泄漏面":能读这页的人本来就能
   *      看到"这里一共多少条讨论",少看到几条正文不构成新的信息。
   */
  async list(operator: Actor, nodeId: string): Promise<CommentListResponse> {
    await this.permissions.requireRead(operator, nodeId);

    // ⚠️ 先查一层(limit+1)而不是"查 N 条再 count" ——
    // 后者是两次查询,而且 count 的那次在长列表页上会越来越慢。
    // 多取一条就足以判断有没有被截断,总数另有一次 count 拿。
    const [threadRows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { nodeId, parentId: null },
        orderBy: { createdAt: 'asc' },
        select: COMMENT_SELECT,
        take: COMMENT_THREADS_MAX + 1,
      }),
      // ⚠️ 计数**包含回复** —— 它要与原来的 `rows.length` 保持一致,
      // 否则节点树角标会在有回复的页面上偏小(那是一个会被当成"少了几条"的回归)。
      this.prisma.comment.count({ where: { nodeId } }),
    ]);

    const truncated = threadRows.length > COMMENT_THREADS_MAX;
    const page = truncated ? threadRows.slice(0, COMMENT_THREADS_MAX) : threadRows;

    // 回复:只取这批顶层的,`parentId IN (...)` 走的是 comments_node_idx 之外的
    // parent_id 过滤,但一层回复的量级很小,这里不额外分页。
    const parentIds = page.map((row) => row.id);
    const replyRows =
      parentIds.length === 0
        ? []
        : await this.prisma.comment.findMany({
            where: { nodeId, parentId: { in: parentIds } },
            orderBy: { createdAt: 'asc' },
            select: COMMENT_SELECT,
          });

    // 祖先所有者能处置任何人的评论;作者本人能处置自己的。两者有其一即可。
    const access = await this.permissions.access(operator, nodeId);
    const canModerateAny = access.canManage;

    const toView = (row: CommentRow, replies: CommentView[]): CommentView => {
      const isMine = row.userId === operator.id;
      return {
        id: row.id,
        nodeId: row.nodeId,
        parentId: row.parentId,
        author: {
          id: row.user.id,
          name: row.user.name,
          avatarColor: row.user.avatarColor,
          departed: row.user.status === 'departed',
        },
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        // 前端据此决定按钮显隐。**服务端仍是唯一裁判** —— 这里只是别让按钮白点。
        //
        // ⚠️ `canEdit` 与 `canDelete` 刻意分开:所有者能删别人的评论(版务),
        // 但**不能改**(篡改他人言论)。之前两个按钮共用一个标志,
        // 结果所有者看得到「编辑」、点了却 403。
        canEdit: isMine,
        canDelete: isMine || canModerateAny,
        replies,
      };
    };

    const repliesOf = new Map<string, CommentView[]>();
    for (const row of replyRows) {
      if (row.parentId === null) continue;
      const bucket = repliesOf.get(row.parentId) ?? [];
      bucket.push(toView(row, []));
      repliesOf.set(row.parentId, bucket);
    }

    const threads = page.map((row) => toView(row, repliesOf.get(row.id) ?? []));

    return {
      nodeId,
      total,
      threads,
      truncated,
    };
  }

  /** 发表评论或回复。**全员可发。** */
  async create(operator: Actor, nodeId: string, input: CreateCommentInput): Promise<CommentView> {
    await this.permissions.requireRead(operator, nodeId);

    const body = input.body.trim();
    if (body === '') throw AppError.validation('评论内容不能为空');
    if (body.length > COMMENT_BODY_MAX_LENGTH) {
      throw AppError.validation(`评论不能超过 ${String(COMMENT_BODY_MAX_LENGTH)} 个字符`);
    }

    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: parentId },
        select: { nodeId: true, parentId: true },
      });
      if (parent === null) throw AppError.notFound();
      // 跨节点挂载会让评论出现在另一个节点下 —— 一串讨论必须落在同一个节点上
      if (parent.nodeId !== nodeId) {
        throw AppError.validation('回复的目标评论不在这个节点下');
      }
      // 只允许一层:回复的回复会被拒,而不是被静默挂到顶层
      if (parent.parentId !== null) {
        throw AppError.validation('回复只有一层,请回复顶层评论');
      }
    }

    const row = await this.prisma.comment.create({
      data: { nodeId, parentId, userId: operator.id, body },
      select: COMMENT_SELECT,
    });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'comment.create',
      targetType: 'comment',
      targetId: row.id,
      detail: { nodeId, isReply: parentId !== null },
    });

    return this.toViewOwn(row);
  }

  /**
   * 改评论正文。**只有作者本人。**
   *
   * ⚠️ 该节点的所有者**也不行** —— 他能删(版务清理),但不能改别人说的话。
   * 这两件事此前共用一道闸,结果是所有者能编辑他人言论;
   * 分开之后 `canEdit` 只认作者,`canDelete` 认作者或祖先所有者。
   */
  async update(
    operator: Actor,
    commentId: string,
    input: UpdateCommentInput,
  ): Promise<CommentView> {
    const existing = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, nodeId: true, userId: true },
    });
    if (existing === null) throw AppError.notFound();

    if (existing.userId !== operator.id) {
      throw AppError.forbidden('只能修改自己的评论');
    }

    const body = input.body.trim();
    if (body === '') throw AppError.validation('评论内容不能为空');
    if (body.length > COMMENT_BODY_MAX_LENGTH) {
      throw AppError.validation(`评论不能超过 ${String(COMMENT_BODY_MAX_LENGTH)} 个字符`);
    }

    const row = await this.prisma.comment.update({
      where: { id: commentId },
      data: { body },
      select: COMMENT_SELECT,
    });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'comment.update',
      targetType: 'comment',
      targetId: commentId,
      detail: { nodeId: existing.nodeId },
    });

    return this.toViewOwn(row);
  }

  /** 删除评论。作者本人,或该节点的任一祖先所有者。回复跟着删(外键级联)。 */
  async remove(operator: Actor, commentId: string): Promise<void> {
    const existing = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, nodeId: true, userId: true },
    });
    if (existing === null) throw AppError.notFound();

    const isMine = existing.userId === operator.id;
    if (!isMine) {
      const access = await this.permissions.access(operator, existing.nodeId);
      if (!access.canManage) throw AppError.forbidden('只能删除自己的评论');
    }

    await this.prisma.comment.delete({ where: { id: commentId } });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'comment.delete',
      targetType: 'comment',
      targetId: commentId,
      detail: { nodeId: existing.nodeId },
    });
  }

  /*
    ⚠️ v2.16 删掉了两个**已经没有调用方**的方法:

      · `commentCounts()` —— 它只服务于那条已被删除的 `GET /comment-counts`。
        树上的角标现在由 `NodeService` 自己 `groupBy` 算(那里本来就要为
        可见性过滤把节点查一遍,顺带算一次比再发一轮请求便宜),
        所以这里这份是第二实现 —— 而"同一件事两处实现"正是会分叉的东西。
      · `assertReadable()` —— 它只是 `permissions.requireRead` 的一层包装,
        而三个调用点都直接调了后者。留着它只会让人以为这里多了一道闸。

    两者都是 public/private 方法,lint 抓不到"没人调用" —— 只能靠人删。
  */

  /**
   * 单条评论的视图。
   *
   * ⚠️ 只在**作者本人**的路径上调用(`create` 与 `update`)——
   * 所以 `canEdit` / `canDelete` 恒为真。这是调用前提,不是巧合。
   */
  private toViewOwn(row: CommentRow): CommentView {
    return {
      id: row.id,
      nodeId: row.nodeId,
      parentId: row.parentId,
      author: {
        id: row.user.id,
        name: row.user.name,
        avatarColor: row.user.avatarColor,
        departed: row.user.status === 'departed',
      },
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit: true,
      canDelete: true,
      replies: [],
    };
  }
}
