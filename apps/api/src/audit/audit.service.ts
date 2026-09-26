/**
 * 审计日志的**读取**侧(DESIGN.md §6.2 的 `GET /audit-logs`)。
 *
 * 写入侧在 `record.ts` —— 那里解释了为什么写入不做成可注入的服务(会形成模块环)。
 *
 * ## ⚠️ v2.0 的可见范围变化
 *
 * 旧模型按「空间」授权:空间管理员能看该空间的日志。
 * 新模型没有"空间成员"这个概念了,改成**按节点子树**:
 *
 *   - **超管**:全部日志
 *   - **其他人**:只能看到「**我拥有所有权的节点及其子树内**发生的动作」,
 *     外加「我自己的操作」
 *
 * 这条规则同时覆盖了两种身份:部长(一级节点所有者)能看到整个部门,
 * 组长(二级节点所有者)只能看到自己那个组。
 *
 * 为什么用 `detail->>'nodeId'` 而不只看 `target_id`:评论、授权这类动作的
 * `target_id` 是评论 id / 用户 id,不是节点 id。写入侧统一在 `detail` 里带了
 * `nodeId`,读取侧靠它认领 —— 这样就不必给 `audit_logs` 加一个
 * "每个调用点都要记得填"的列(填漏一条就是一次越权可见)。
 */

import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_PAGE_SIZE,
  type Actor,
  type AuditLogPage,
  type AuditLogView,
} from '@knowledgecool/shared';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** `$queryRaw` 的返回行。列名与 SQL 里的别名逐字对应。 */
interface RawAuditRow {
  id: bigint;
  action: string;
  target_type: string;
  target_id: string;
  detail: unknown;
  ip: string | null;
  created_at: Date;
  actor_id: string | null;
  actor_name: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询审计日志。
   *
   * 用 `$queryRaw` 而不是 `findMany`,是因为筛选项里有一个
   * 「JSON 字段的某个键落在某个 id 集合里」的条件 —— Prisma 的
   * `where` 能表达 `equals`,但表达不了 `in`,而把几百个 id 拼成几百个
   * `OR` 条件既难看又慢。
   */
  async list(
    operator: Actor,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<AuditLogPage> {
    const limit = Math.min(Math.max(options.limit ?? AUDIT_PAGE_SIZE, 1), 200);
    const scopeIds = await this.visibleNodeIds(operator);
    const cursor = options.cursor ?? null;

    const rows = await this.prisma.$queryRaw<RawAuditRow[]>(Prisma.sql`
      SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
             u.id AS actor_id, u.name AS actor_name
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_id
       WHERE (
               ${operator.isSuperAdmin}::boolean
               OR a.actor_id = ${operator.id}::uuid
               OR a.target_id = ANY(${scopeIds}::text[])
               OR a.detail->>'nodeId' = ANY(${scopeIds}::text[])
             )
         AND (${cursor}::bigint IS NULL OR a.id < ${cursor}::bigint)
       ORDER BY a.id DESC
       LIMIT ${limit + 1}::int
    `);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const labels = await this.resolveTargetLabels(page);

    const items: AuditLogView[] = page.map((row) => ({
      id: row.id.toString(),
      actor:
        row.actor_id === null
          ? null
          : { id: row.actor_id, name: row.actor_name ?? '未知' },
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      targetLabel: labels.get(`${row.target_type}:${row.target_id}`) ?? null,
      detail: (row.detail ?? {}) as Record<string, unknown>,
      ip: row.ip,
      createdAt: row.created_at.toISOString(),
    }));

    const last = page.at(-1);
    return { items, nextCursor: hasMore && last !== undefined ? last.id.toString() : null };
  }

  /**
   * 「我拥有所有权的节点」及其**全部后代**的 id。
   *
   * 超管返回空数组 —— 他走 `isSuperAdmin` 分支直接看全部,
   * 算了也用不上,而全表扫一遍节点在大实例上并不便宜。
   *
   * 一次查询搞定:把每个所有者节点的路径前缀展开成 `OR` 条件。
   * 所有者节点数通常是个位数(一个部长管几个组),所以这个 `OR` 很短。
   */
  private async visibleNodeIds(operator: Actor): Promise<string[]> {
    if (operator.isSuperAdmin) return [];

    const owned = await this.prisma.node.findMany({
      where: { ownerId: operator.id },
      select: { materializedPath: true },
    });
    if (owned.length === 0) return [];

    const rows = await this.prisma.node.findMany({
      where: {
        OR: owned.flatMap((node) => [
          { materializedPath: node.materializedPath },
          // 前缀末尾的斜杠不能省:否则 /p-1 会被当成 /p-10 的祖先
          { materializedPath: { startsWith: `${node.materializedPath}/` } },
        ]),
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** 批量把 target_id 换成人看得懂的名字。一次查询解决,不做 N+1。 */
  private async resolveTargetLabels(
    rows: readonly { target_type: string; target_id: string }[],
  ): Promise<Map<string, string>> {
    const nodeIds = rows.filter((r) => r.target_type === 'node').map((r) => r.target_id);
    const userIds = rows.filter((r) => r.target_type === 'user').map((r) => r.target_id);

    const [nodes, users] = await Promise.all([
      nodeIds.length === 0
        ? Promise.resolve([])
        : this.prisma.node.findMany({
            where: { id: { in: nodeIds } },
            select: { id: true, title: true },
          }),
      userIds.length === 0
        ? Promise.resolve([])
        : this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          }),
    ]);

    const map = new Map<string, string>();
    for (const row of nodes) map.set(`node:${row.id}`, row.title);
    for (const row of users) map.set(`user:${row.id}`, row.name);
    return map;
  }
}

/** 动作的中文名。映射表放在 shared,前端复用同一份。 */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
