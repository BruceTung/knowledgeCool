/**
 * 审计日志的**读取**侧(DESIGN.md §6.2 的 `GET /audit-logs`)。
 *
 * 写入侧在 `record.ts` —— 那里解释了为什么写入不做成可注入的服务
 * (会形成模块环)。本服务只负责查询,所以可以放心依赖 SpaceModule 做鉴权。
 */

import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_PAGE_SIZE,
  type AuditLogPage,
  type AuditLogView,
} from '@knowledgecool/shared';

import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SpaceService } from '../space/space.service.js';

/** 操作者的最小形态。与 SpaceService 的 `Operator` 结构一致。 */
interface Operator {
  id: string;
  isSuperAdmin: boolean;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpaceService,
  ) {}

  /**
   * 查询审计日志。
   *
   * 阶段一**按空间授权**:有空间管理员权限(`audit.view`,admin 起)就能看该空间的日志。
   * 全局日志(跨空间)只对超管开放 —— 否则一个空间的管理员能看到
   * 他本不该知道的其他空间的存在(违反 §5.3 最小可见)。
   */
  async list(
    operator: Operator,
    options: { spaceId?: string; cursor?: string; limit?: number },
  ): Promise<AuditLogPage> {
    const limit = Math.min(Math.max(options.limit ?? AUDIT_PAGE_SIZE, 1), 200);

    let targetFilter: Prisma.AuditLogWhereInput;

    if (options.spaceId !== undefined) {
      await this.spaces.requireCapability(operator, options.spaceId, 'audit.view');
      targetFilter = await this.spaceTargetFilter(options.spaceId);
    } else {
      if (!operator.isSuperAdmin) {
        throw AppError.forbidden('只有超级管理员可以查看跨空间的审计日志');
      }
      targetFilter = {};
    }

    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...targetFilter,
        ...(options.cursor === undefined ? {} : { id: { lt: BigInt(options.cursor) } }),
      },
      orderBy: { id: 'desc' },
      take: limit + 1, // 多取一条用于判断还有没有下一页
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        detail: true,
        ip: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const labels = await this.resolveTargetLabels(page);

    const items: AuditLogView[] = page.map((row) => ({
      id: row.id.toString(),
      actor: row.actor,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: labels.get(`${row.targetType}:${row.targetId}`) ?? null,
      detail: (row.detail ?? {}) as Record<string, unknown>,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    }));

    const last = page.at(-1);
    return { items, nextCursor: hasMore && last !== undefined ? last.id.toString() : null };
  }

  /**
   * 把审计条目限定在一个空间内。
   *
   * 麻烦在于 `audit_logs` 只有 `target_type/target_id`,没有 `space_id` ——
   * 加一列当然更直接,但那意味着每条写日志的调用点都要负责填对空间,
   * 填漏一条就是一次越权可见。这里改成按目标反查,把正确性集中在读取侧。
   */
  private async spaceTargetFilter(spaceId: string): Promise<Prisma.AuditLogWhereInput> {
    const [pageIds, memberIds] = await Promise.all([
      this.prisma.page.findMany({ where: { spaceId }, select: { id: true } }),
      this.prisma.spaceMember.findMany({ where: { spaceId }, select: { userId: true } }),
    ]);

    return {
      OR: [
        { targetType: 'space', targetId: spaceId },
        ...pageIds.map((row) => ({ targetType: 'page', targetId: row.id })),
        ...memberIds.map((row) => ({
          targetType: 'space_member',
          targetId: `${spaceId}:${row.userId}`,
        })),
        // 评论的目标 id 是 comment.id,反查成本高;用 detail.spaceId 认领。
        // 写入方(recordAudit 的调用点)会带上它。
        { detail: { path: ['spaceId'], equals: spaceId } },
        // 登录 / 登出 / 初始化没有空间归属(targetType 是 user,detail 里也没有 spaceId),
        // 但对安全审计来说「谁登录过」恰恰是最该看的一类。
        // 这里按**操作者是不是本空间成员**认领 —— 空间管理员能看到自己成员的登录记录,
        // 看不到别的空间的人。
        ...(memberIds.length === 0
          ? []
          : [
              {
                action: { in: ['auth.login', 'auth.logout', 'auth.setup'] },
                actorId: { in: memberIds.map((row) => row.userId) },
              },
            ]),
      ],
    };
  }

  /** 批量把 target_id 换成人看得懂的名字。一次查询解决,不做 N+1。 */
  private async resolveTargetLabels(
    rows: readonly { targetType: string; targetId: string }[],
  ): Promise<Map<string, string>> {
    const pageIds = rows.filter((r) => r.targetType === 'page').map((r) => r.targetId);
    const spaceIds = rows.filter((r) => r.targetType === 'space').map((r) => r.targetId);

    const [pages, spaces] = await Promise.all([
      pageIds.length === 0
        ? Promise.resolve([])
        : this.prisma.page.findMany({
            where: { id: { in: pageIds } },
            select: { id: true, title: true },
          }),
      spaceIds.length === 0
        ? Promise.resolve([])
        : this.prisma.space.findMany({
            where: { id: { in: spaceIds } },
            select: { id: true, name: true },
          }),
    ]);

    const map = new Map<string, string>();
    for (const row of pages) map.set(`page:${row.id}`, row.title);
    for (const row of spaces) map.set(`space:${row.id}`, row.name);
    return map;
  }
}

/** 动作的中文名。映射表放在 shared,前端复用同一份。 */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
