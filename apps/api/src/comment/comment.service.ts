/**
 * 评论服务(DESIGN.md §8.4)。
 *
 * ## 阶段一的边界(刻意画死)
 *
 * - **不锚定到文字**:没有 anchor 字段。锚点绑在正文结构上,阶段二正文模型一动锚点全废,
 *   所以列刻意不加 —— 免得后来人顺手实现一个"半锚定"版本。
 * - **只有一层回复**:`parentId` 指向的那条必须自己也是顶层评论。
 *   无限嵌套在 UI 上极难表达,而知识库的讨论几乎不需要它。
 * - **不发任何通知**(§8.4)。用户靠页面树上的角标知道有新评论。
 *
 * ## 谁能做什么
 *
 * | 动作 | 门槛 |
 * |---|---|
 * | 看评论 | viewer |
 * | 发表 / 回复 | commenter |
 * | 改自己的评论正文 / 标为已解决 | 作者本人 |
 * | 标为已解决(他人的) | editor |
 * | 删除 | 作者本人,或空间管理员 |
 */

import { Injectable } from '@nestjs/common';
import {
  COMMENT_BODY_MAX_LENGTH,
  type CommentListResponse,
  type CommentView,
  type CreateCommentInput,
  type UpdateCommentInput,
  type Actor,
  can,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../permission/permission.service.js';

const COMMENT_SELECT = {
  id: true,
  pageId: true,
  parentId: true,
  body: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  user: { select: { id: true, name: true, avatarColor: true } },
} satisfies Prisma.CommentSelect;

type CommentRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>;

@Injectable()
export class CommentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /** 页面评论列表。顶层评论按时间正序,回复挂在各自的 `replies` 下。 */
  async list(operator: Actor, pageId: string): Promise<CommentListResponse> {
    const access = await this.permissions.requireCapability(operator, pageId, 'page.view');

    const rows = await this.prisma.comment.findMany({
      where: { pageId },
      orderBy: { createdAt: 'asc' },
      select: COMMENT_SELECT,
    });

    const canResolveAny = can(access.role, 'comment.resolve.any');
    const canDeleteAny = can(access.role, 'comment.delete.any');

    const toView = (row: CommentRow, replies: CommentView[]): CommentView => {
      const isMine = row.userId === operator.id;
      return {
        id: row.id,
        pageId: row.pageId,
        parentId: row.parentId,
        author: {
          id: row.user.id,
          name: row.user.name,
          avatarColor: row.user.avatarColor,
        },
        body: row.body,
        status: row.status === 'resolved' ? 'resolved' : 'open',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        // 前端据此决定按钮显隐。**服务端仍是唯一裁判** —— 这里只是别让按钮白点。
        canResolve: isMine || canResolveAny,
        canDelete: isMine || canDeleteAny,
        replies,
      };
    };

    const repliesOf = new Map<string, CommentView[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const list = repliesOf.get(row.parentId) ?? [];
      list.push(toView(row, []));
      repliesOf.set(row.parentId, list);
    }

    const threads = rows
      .filter((row) => row.parentId === null)
      .map((row) => toView(row, repliesOf.get(row.id) ?? []));

    const openCount = rows.filter((row) => row.status !== 'resolved').length;

    return {
      pageId,
      total: rows.length,
      openCount,
      threads,
    };
  }

  /** 发表评论或回复。 */
  async create(
    operator: Actor,
    pageId: string,
    input: CreateCommentInput,
  ): Promise<CommentView> {
    const access = await this.permissions.requireCapability(operator, pageId, 'comment.create');

    const body = input.body.trim();
    if (body === '') throw AppError.validation('评论内容不能为空');
    if (body.length > COMMENT_BODY_MAX_LENGTH) {
      throw AppError.validation(`评论不能超过 ${COMMENT_BODY_MAX_LENGTH} 个字符`);
    }

    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: parentId },
        select: { pageId: true, parentId: true },
      });
      if (parent === null) throw AppError.notFound();
      // 跨页面引用能让评论出现在你没权限的页面上 —— 必须挡住
      if (parent.pageId !== pageId) {
        throw AppError.validation('回复的目标评论不在这个页面上');
      }
      // 只允许一层:回复的回复会被挂到同一条顶层评论下,而不是形成链
      if (parent.parentId !== null) {
        throw AppError.validation('回复只有一层,请回复顶层评论');
      }
    }

    const row = await this.prisma.comment.create({
      data: { pageId, parentId, userId: operator.id, body },
      select: COMMENT_SELECT,
    });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'comment.create',
      targetType: 'comment',
      targetId: row.id,
      detail: { spaceId: access.page.spaceId, pageId, isReply: parentId !== null },
    });

    return {
      id: row.id,
      pageId: row.pageId,
      parentId: row.parentId,
      author: { id: row.user.id, name: row.user.name, avatarColor: row.user.avatarColor },
      body: row.body,
      status: row.status === 'resolved' ? 'resolved' : 'open',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canResolve: true,
      canDelete: true,
      replies: [],
    };
  }

  /**
   * 改正文 / 切换解决状态。
   *
   * 两种操作的权限**不同**,所以不能用同一道闸:
   *  - 改正文:只有作者本人(编辑别人的话是篡改他人言论)
   *  - 标为已解决:作者本人**或** editor 以上(§5.4 的两格)
   */
  async update(
    operator: Actor,
    commentId: string,
    input: UpdateCommentInput,
  ): Promise<CommentView> {
    const existing = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, pageId: true, userId: true, parentId: true },
    });
    if (existing === null) throw AppError.notFound();

    // 能改就不会是自己看不到的页面 —— 但仍要过一遍,防止"先看到再被降权"
    const access = await this.permissions.requireCapability(operator, existing.pageId, 'page.view');
    const isMine = existing.userId === operator.id;

    if (input.body !== undefined) {
      if (!isMine) throw AppError.forbidden('只能修改自己的评论');
      const body = input.body.trim();
      if (body === '') throw AppError.validation('评论内容不能为空');
      if (body.length > COMMENT_BODY_MAX_LENGTH) {
        throw AppError.validation(`评论不能超过 ${COMMENT_BODY_MAX_LENGTH} 个字符`);
      }
    }

    if (input.status !== undefined) {
      const capability = isMine ? 'comment.resolve.own' : 'comment.resolve.any';
      if (!can(access.role, capability)) {
        throw AppError.forbidden(
          isMine ? '你没有标记评论的权限' : '标记他人评论需要编辑者权限',
        );
      }
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
        spaceId: access.page.spaceId,
        pageId: existing.pageId,
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    });

    return {
      id: row.id,
      pageId: row.pageId,
      parentId: row.parentId,
      author: { id: row.user.id, name: row.user.name, avatarColor: row.user.avatarColor },
      body: row.body,
      status: row.status === 'resolved' ? 'resolved' : 'open',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canResolve: true,
      canDelete: isMine || can(access.role, 'comment.delete.any'),
      replies: [],
    };
  }

  /** 删除评论。作者本人或空间管理员。回复会跟着删(外键级联)。 */
  async remove(operator: Actor, commentId: string): Promise<void> {
    const existing = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, pageId: true, userId: true },
    });
    if (existing === null) throw AppError.notFound();

    const access = await this.permissions.requireCapability(operator, existing.pageId, 'page.view');
    const isMine = existing.userId === operator.id;

    if (!isMine && !can(access.role, 'comment.delete.any')) {
      throw AppError.forbidden('只能删除自己的评论');
    }

    await this.prisma.comment.delete({ where: { id: commentId } });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'comment.delete',
      targetType: 'comment',
      targetId: commentId,
      detail: { spaceId: access.page.spaceId, pageId: existing.pageId },
    });
  }

  /** 各页面的未解决评论数 —— 页面树角标用。一次查询取回整空间,不做 N+1。 */
  async openCounts(operator: Actor, spaceId: string): Promise<Record<string, number>> {
    await this.permissions.visibility(operator, spaceId);

    const rows = await this.prisma.comment.groupBy({
      by: ['pageId'],
      where: { status: 'open', page: { spaceId, deletedAt: null } },
      _count: { _all: true },
    });

    return Object.fromEntries(rows.map((row) => [row.pageId, row._count._all]));
  }
}
