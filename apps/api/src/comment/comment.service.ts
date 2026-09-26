/**
 * 评论服务(DESIGN.md §8.4 / §5.4)。
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
 * | 标为已解决 / 删除 | 作者本人,或该节点的**任一祖先所有者** |
 */

import { Injectable } from '@nestjs/common';
import {
  COMMENT_BODY_MAX_LENGTH,
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
  status: true,
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
   * **不鉴权** —— 读全员开放(§5.3 规则一)。但仍确认节点存在且未删除,
   * 否则前端无法区分"这篇没人评论"与"这篇不存在"。
   */
  async list(operator: Actor, nodeId: string): Promise<CommentListResponse> {
    await this.assertNodeVisible(nodeId);

    const rows = await this.prisma.comment.findMany({
      where: { nodeId },
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
        status: row.status === 'resolved' ? 'resolved' : 'open',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        // 前端据此决定按钮显隐。**服务端仍是唯一裁判** —— 这里只是别让按钮白点。
        canResolve: isMine || canModerateAny,
        canDelete: isMine || canModerateAny,
        replies,
      };
    };

    const repliesOf = new Map<string, CommentView[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const bucket = repliesOf.get(row.parentId) ?? [];
      bucket.push(toView(row, []));
      repliesOf.set(row.parentId, bucket);
    }

    const threads = rows
      .filter((row) => row.parentId === null)
      .map((row) => toView(row, repliesOf.get(row.id) ?? []));

    return {
      nodeId,
      total: rows.length,
      openCount: rows.filter((row) => row.status !== 'resolved').length,
      threads,
    };
  }

  /** 发表评论或回复。**全员可发。** */
  async create(
    operator: Actor,
    nodeId: string,
    input: CreateCommentInput,
  ): Promise<CommentView> {
    await this.assertNodeVisible(nodeId);

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
   * 改正文 / 切换解决状态。
   *
   * ⚠️ 两种操作的权限**不同**,所以共用一道闸会给错权限:
   *   - 改正文:**只有作者本人**(编辑别人的话是篡改他人言论)
   *   - 标为已解决:作者本人**或**该节点的任一祖先所有者(§5.4 的两格)
   */
  async update(
    operator: Actor,
    commentId: string,
    input: UpdateCommentInput,
  ): Promise<CommentView> {
    const existing = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, nodeId: true, userId: true, parentId: true },
    });
    if (existing === null) throw AppError.notFound();

    const isMine = existing.userId === operator.id;

    // 只有非作者才需要查"是不是祖先所有者",作者本人直接放行
    const canModerateAny = isMine
      ? true
      : (await this.permissions.access(operator, existing.nodeId)).canManage;

    if (input.body !== undefined) {
      if (!isMine) throw AppError.forbidden('只能修改自己的评论');
      const body = input.body.trim();
      if (body === '') throw AppError.validation('评论内容不能为空');
      if (body.length > COMMENT_BODY_MAX_LENGTH) {
        throw AppError.validation(`评论不能超过 ${String(COMMENT_BODY_MAX_LENGTH)} 个字符`);
      }
    }

    if (input.status !== undefined && !canModerateAny) {
      throw AppError.forbidden('标记他人的评论需要是该节点的所有者或上级所有者');
    }

    if (input.body === undefined && input.status === undefined) {
      throw AppError.validation('没有要修改的内容');
    }

    const row = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        ...(input.body === undefined ? {} : { body: input.body.trim() }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      select: COMMENT_SELECT,
    });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'comment.update',
      targetType: 'comment',
      targetId: commentId,
      detail: {
        nodeId: existing.nodeId,
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    });

    return this.toViewOwn(row, canModerateAny);
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

  /**
   * 一批节点的未解决评论数 —— 节点树角标用。
   *
   * 签名从 `(operator, spaceId)` 改成 `(nodeIds)`:
   * 树现在一次返回全公司,角标要跟着节点列表走,而不是跟着空间走。
   */
  async openCounts(nodeIds: readonly string[]): Promise<Record<string, number>> {
    if (nodeIds.length === 0) return {};

    const rows = await this.prisma.comment.groupBy({
      by: ['nodeId'],
      where: { status: 'open', nodeId: { in: [...nodeIds] } },
      _count: { _all: true },
    });

    return Object.fromEntries(rows.map((row) => [row.nodeId, row._count._all]));
  }

  private async assertNodeVisible(nodeId: string): Promise<void> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { deletedAt: true },
    });
    if (node === null || node.deletedAt !== null) throw AppError.notFound();
  }

  private toViewOwn(row: CommentRow, canModerateAny = true): CommentView {
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
      status: row.status === 'resolved' ? 'resolved' : 'open',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canResolve: canModerateAny,
      canDelete: canModerateAny,
      replies: [],
    };
  }
}
