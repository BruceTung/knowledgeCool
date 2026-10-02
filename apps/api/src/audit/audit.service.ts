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
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_PAGE_SIZE,
  toCsv,
  type Actor,
  type AuditLogPage,
  type AuditLogView,
} from '@knowledgecool/shared';

import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * 游标规范化。
 *
 * ⚠️ 游标必须**先校验**再进 SQL。原实现把查询串原样拼进 `::bigint`,
 * 于是 `?cursor=abc` 会让 PostgreSQL 抛 22P02(非法整数文本),再被全局过滤器
 * 兜成 500 INTERNAL_ERROR —— 一个纯客户端的参数错误显示成"服务器内部错误",
 * 而且**任何登录用户都能触发**,还在日志里留下假的故障记录。
 *
 * 只接受纯数字串:审计主键是 bigint,JSON 装不下 64 位整数,所以按字符串往返。
 * 空串与 undefined 一律当作"没有游标"(第一页);其它情况明确 400。
 */
export function normalizeCursor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // 19 位是 signed 64-bit 的十进制上限,再多必然溢出
  if (!/^[0-9]{1,19}$/.test(trimmed)) throw AppError.validation('分页游标不合法');
  return trimmed;
}

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
    options: { cursor?: string; limit?: number; action?: string } = {},
  ): Promise<AuditLogPage> {
    const limit = Math.min(Math.max(options.limit ?? AUDIT_PAGE_SIZE, 1), 200);
    const scopeIds = await this.visibleNodeIds(operator);
    // 先校验再进 SQL —— 见 normalizeCursor 的注释
    const cursor = normalizeCursor(options.cursor);

    /*
      按动作筛选(v2.14)。

      ⚠️ 筛选必须做在**服务端**。在客户端对已加载的那几页过滤是错的:
      那是游标分页,当前页里没有匹配项时会显示"没有记录",
      而更早的页里其实有 —— 用户会得出"这种操作从来没发生过"的错误结论。
      审计页恰恰是最不能给错结论的地方。

      空串按"不筛选"处理,免得前端传一个空 select 就把结果清空。
    */
    const action = options.action === undefined || options.action === '' ? null : options.action;

    // ⚠️ 必须多取一条:下面的 `hasMore` 是 `rows.length > limit`,
    // 而 SQL 用的是 `LIMIT ${limit}` —— 只取 limit 条的话,`rows.length`
    // 永远不会超过 limit,`hasMore` 恒为 false,`nextCursor` 恒为 null。
    // 表现是**审计页永远只能看到最近一页,更早的记录翻不出来**,
    // 而界面上没有任何报错 —— 与 exportCsv 那处「多取一条」的写法对齐。
    const rows = await this.queryRows(operator, { scopeIds, action, cursor, limit: limit + 1 });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const labels = await this.resolveTargetLabels(page);

    const items: AuditLogView[] = page.map((row) => ({
      id: row.id.toString(),
      actor: row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name ?? '未知' },
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
   * 唯一的查询入口 —— list 与 exportCsv **共用同一个 WHERE**。
   *
   * ⚠️ 导出绝不能自己再写一遍范围条件。可见范围那四条 OR 是审计的**唯一**
   * 访问控制,复制一份出去迟早会与这份分叉 —— 而分叉的表现是
   * 「导出的 CSV 里出现了他在页面上看不到的记录」,也就是**一次越权读取**,
   * 且没有任何地方会报错(§12:凡是读数据的逻辑,只允许存在一份)。
   */
  private async queryRows(
    operator: Actor,
    params: {
      scopeIds: readonly string[];
      action: string | null;
      cursor: string | null;
      limit: number;
    },
  ): Promise<RawAuditRow[]> {
    const { scopeIds, action, cursor, limit } = params;
    const ids = [...scopeIds];
    return this.prisma.$queryRaw<RawAuditRow[]>(Prisma.sql`
      SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
             u.id AS actor_id, u.name AS actor_name
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_id
       WHERE (
               ${operator.isSuperAdmin}::boolean
               OR a.actor_id = ${operator.id}::uuid
               OR a.target_id = ANY(${ids}::text[])
               OR a.detail->>'nodeId' = ANY(${ids}::text[])
             )
         AND (${action}::text IS NULL OR a.action = ${action}::text)
         AND (${cursor}::bigint IS NULL OR a.id < ${cursor}::bigint)
       ORDER BY a.id DESC
       LIMIT ${limit}::int
    `);
  }

  /**
   * 导出为 CSV(v2.14)。
   *
   * 与 list **共用 queryRows** —— 范围条件绝不能有第二份。
   *
   * 两个刻意的限制:
   *   · **有行数上限**。审计表只增不减,不加限制就是一次全表扫描加一个
   *     几百 MB 的响应,足以把服务打挂。超了就明确告诉用户「只导出了最近 N 条」,
   *     而不是静默截断 —— **审计数据的静默截断比没有导出更糟**。
   *   · **不分页**。导出要的是一份完整文件,分页是界面的事。
   */
  async exportCsv(
    operator: Actor,
    options: { action?: string } = {},
  ): Promise<{ csv: string; exported: number; capped: boolean }> {
    const scopeIds = await this.visibleNodeIds(operator);
    const action = options.action === undefined || options.action === '' ? null : options.action;

    // 多取一条用来判断「还有没有」,与 list 里的做法一致
    const rows = await this.queryRows(operator, {
      scopeIds,
      action,
      cursor: null,
      limit: AUDIT_EXPORT_MAX_ROWS + 1,
    });

    const capped = rows.length > AUDIT_EXPORT_MAX_ROWS;
    const page = capped ? rows.slice(0, AUDIT_EXPORT_MAX_ROWS) : rows;
    const labels = await this.resolveTargetLabels(page);

    const header = ['时间', '操作者', '动作', '目标类型', '目标', '来源 IP', '细节'];
    const body = page.map((row) => [
      row.created_at.toISOString(),
      row.actor_name ?? '(系统)',
      AUDIT_ACTION_LABELS[row.action] ?? row.action,
      row.target_type,
      labels.get(`${row.target_type}:${row.target_id}`) ?? row.target_id,
      row.ip,
      JSON.stringify(row.detail ?? {}),
    ]);

    return { csv: toCsv(header, body), exported: page.length, capped };
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
