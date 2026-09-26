/**
 * 页面级权限判定(DESIGN.md §5)。
 *
 * 这是 `packages/shared/src/permission.ts` 里那套**纯函数**的"带 IO 的壳子":
 * 它负责取物化路径上的祖先、取规则、读写 Redis 缓存,然后把判定交给纯函数。
 * 拆成两半的原因是纯函数那半能被单测覆盖到每一条铁律(§12 的测试优先级:
 * 权限判定是"错了不会立刻报错"的高危逻辑)。
 *
 * ## 缓存策略(对 DESIGN §5.5 的一处实现级改进)
 *
 * §5.5 写的是「变更时按路径前缀批量失效」。实现时改成了**空间级世代号**:
 * `kc:perm:gen:<spaceId>` 是个自增计数器,缓存 key 里带上它的当前值。
 * 任何规则变更让它 +1,旧 key 就自然"不可达",靠 TTL 自己过期。
 *
 * 为什么不用 `SCAN` + 按前缀 `DEL`:
 *  - `SCAN` 是 O(全库 key 数)的逐桶遍历,大实例上会明显拖慢其他命令;
 *  - 更危险的是**它可能漏** —— 遍历期间新写入的 key 不在已扫过的桶里,会活到 TTL。
 *    表现就是"权限已经改了,但某个人还有权限",这类 bug 不报错,只静默越权。
 *  - 世代号只有一处状态、一次 INCR,不存在漏删。
 *
 * 代价是「改一条规则会让整个空间的权限缓存失效一次」。规则变更是低频操作
 * (管理员手动改),重算只是一次数据库查询 —— 这个交换划算。
 */

import { Injectable } from '@nestjs/common';
import {
  can,
  effectiveRoleFrom,
  isPageRuleRole,
  toEffectiveRole,
  toSpaceRole,
  type Actor,
  type Capability,
  type ChainStep,
  type EffectiveRole,
  type PagePermissionsResponse,
  type PageRuleView,
  type PermissionRule,
  type PermissionSubjectCandidate,
  type SavePagePermissionsInput,
  type SpaceRole,
  type SubjectContext,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { SpaceService } from '../space/space.service.js';

/** 缓存 TTL,与 DESIGN §5.5 一致:变更最迟 30 秒全场生效。 */
const CACHE_TTL_SECONDS = 30;

/**
 * 权限判定所需的操作者。只取两个字段,便于单测直接构造字面量。
 * `AuthUser` 天然满足它。
 */
export type Operator = Pick<Actor, 'id' | 'isSuperAdmin'>;

/** 判定结果 + 上下文。所有需要页面级鉴权的调用点都拿这个。 */
export interface PageAccess {
  role: EffectiveRole;
  spaceRole: SpaceRole | null;
  /** 这次判定是否来自超管直通 —— 调用方**必须**写审计日志(§5.2)。 */
  viaSuperAdmin: boolean;
  page: PageAccessPage;
}

/**
 * 判定时用到的页面字段。
 *
 * 刻意取**和 page.service 的 PAGE_SELECT 一样宽**:判定之外,调用点
 * (detail / restore / purge / remove)还要拿这些字段组装响应。
 * 取窄了就得为了几个展示字段再查一次库 —— 那种省法省错了地方。
 */
export interface PageAccessPage {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  position: number;
  status: string;
  version: number;
  materializedPath: string;
  depth: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PAGE_ACCESS_SELECT = {
  id: true,
  spaceId: true,
  parentId: true,
  title: true,
  position: true,
  status: true,
  version: true,
  materializedPath: true,
  depth: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PageSelect;

type PageAccessRow = Prisma.PageGetPayload<{ select: typeof PAGE_ACCESS_SELECT }>;

/** 可见性快照。`unrestricted=true` 表示"这个空间没有页面级规则,全员可见同一棵树"。 */
export interface VisibilitySnapshot {
  spaceRole: SpaceRole | null;
  unrestricted: boolean;
  allowed: ReadonlySet<string>;
}

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpaceService,
    private readonly redis: RedisService,
  ) {}

  // ==================================================================
  // 判定
  // ==================================================================

  /**
   * 解析操作者对某页面的有效角色。
   *
   * 不可见时抛 `NOT_FOUND` 而不是 `FORBIDDEN` —— §5.3 的最小可见:
   * 否则 403 与 404 的差别就成了"这个 id 存不存在"的探测器。
   *
   * @param options.allowDeleted 回收站里的操作(restore / purge)需要它。
   */
  async access(
    operator: Operator,
    pageId: string,
    options?: { allowDeleted?: boolean },
  ): Promise<PageAccess> {
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: PAGE_ACCESS_SELECT,
    });
    if (page === null) throw AppError.notFound();
    if (page.deletedAt !== null && options?.allowDeleted !== true) throw AppError.notFound();

    const space = await this.spaces.lookupRole(operator, page.spaceId);
    if (space.space === null) throw AppError.notFound();

    // 超管直通(§5.2)。有效角色视为 admin,调用方负责写审计。
    if (space.isSuperAdmin) {
      return { role: 'admin', spaceRole: 'admin', viaSuperAdmin: true, page };
    }

    if (space.role === null) throw AppError.notFound();

    const role = await this.resolveRole(operator, page, space.role);
    if (role === 'none') throw AppError.notFound();

    return { role, spaceRole: space.role, viaSuperAdmin: false, page };
  }

  /** 断言操作者具备某能力。**所有**页面级操作都必须过这里。 */
  async requireCapability(
    operator: Operator,
    pageId: string,
    capability: Capability,
    options?: { allowDeleted?: boolean },
  ): Promise<PageAccess> {
    const access = await this.access(operator, pageId, options);
    if (!can(access.role, capability)) {
      throw AppError.forbidden(describeCapability(capability));
    }
    return access;
  }

  /**
   * 页面**创建**的权限检查。
   *
   * 创建时目标页面还不存在,所以检查对象是**父节点**:对父节点有 `page.create`
   * 才能往里加子页(§8.1 第 3 步)。建在空间根下时回退到空间角色。
   *
   * 这一步容易漏,漏了的后果是:一个被 deny 掉的页面下面还能长出新页面,
   * 而新页面又能被创建者看到 —— 权限模型直接被绕过。
   *
   * @returns 建在根下时返回 `null`;否则返回**父页面的行**,
   *          让调用方直接拿 `materializedPath` / `depth` 用,不必再查一次库。
   */
  async requireCreateIn(
    operator: Operator,
    spaceId: string,
    parentId: string | null,
  ): Promise<PageAccessPage | null> {
    if (parentId === null) {
      await this.spaces.requireCapability(operator, spaceId, 'page.create');
      return null;
    }

    const parent = await this.requireCapability(operator, parentId, 'page.create');
    if (parent.page.spaceId !== spaceId) {
      throw AppError.validation('父页面不在这个空间里');
    }
    return parent.page;
  }

  /**
   * 算出某空间内**当前用户可见**的页面 id 集合。
   *
   * 走的是「一次性取回该空间全部页面 + 全部规则,在内存里沿父子指针走链」的路子,
   * 而不是每个页面查一次库 —— 树是整棵加载的,链的深度通常不超过 5 层,
   * 这个 O(节点数 × 深度) 的纯计算远好过 N 次往返。
   */
  async visibility(operator: Operator, spaceId: string): Promise<VisibilitySnapshot> {
    const space = await this.spaces.lookupRole(operator, spaceId);
    if (space.isSuperAdmin) {
      return { spaceRole: 'admin', unrestricted: true, allowed: new Set() };
    }
    if (space.role === null) throw AppError.notFound();

    const rules = await this.prisma.pagePermission.findMany({
      where: { page: { spaceId } },
      select: { pageId: true, subjectType: true, subjectId: true, role: true, deny: true },
    });

    // 快路径:这个空间一条页面级规则都没有,所有人看到同一棵树。
    // 知识库的常态就是这一支 —— 权限基本都配在空间层,省掉这里的开销很值。
    if (rules.length === 0) {
      return { spaceRole: space.role, unrestricted: true, allowed: new Set() };
    }

    const [pages, ctx] = await Promise.all([
      this.prisma.page.findMany({
        where: { spaceId, deletedAt: null },
        select: { id: true, parentId: true },
      }),
      this.subjectContext(operator.id),
    ]);

    const rulesByPage = groupRules(rules);
    const allowed = new Set<string>();

    for (const page of pages) {
      const chain = chainOf(page.id, pages, rulesByPage);
      if (effectiveRoleFrom(chain, ctx, space.role) !== 'none') allowed.add(page.id);
    }

    return { spaceRole: space.role, unrestricted: false, allowed };
  }

  // ==================================================================
  // 规则读写
  // ==================================================================

  /** `GET /pages/:id/permissions`:本页显式规则 + 从根到自身的推导链。 */
  async overview(operator: Operator, pageId: string): Promise<PagePermissionsResponse> {
    const access = await this.requireCapability(operator, pageId, 'page.view');

    const ids = [...ancestorIdsOf(access.page.materializedPath), pageId];

    const [pages, rules, ctx, mine] = await Promise.all([
      this.prisma.page.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true, depth: true },
      }),
      this.prisma.pagePermission.findMany({
        where: { pageId: { in: ids } },
        orderBy: { createdAt: 'asc' },
        select: { pageId: true, subjectType: true, subjectId: true, role: true, deny: true },
      }),
      this.subjectContext(operator.id),
      this.prisma.pagePermission.findMany({
        where: { pageId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, subjectType: true, subjectId: true, role: true, deny: true },
      }),
    ]);

    const infoOf = new Map(pages.map((row) => [row.id, row]));
    const byPage = groupRules(rules);

    // ⚠️ 链必须**从根到自身**。顺序错了判定结果就全错
    // (见 packages/shared/src/permission.ts 顶部的说明)。
    const chain = ids.map((id) => ({ pageId: id, rules: byPage.get(id) ?? [] }));
    const titles = ids.map((id) => {
      const info = infoOf.get(id);
      return { title: info?.title ?? '', depth: info?.depth ?? 0 };
    });

    return {
      pageId,
      pageTitle: access.page.title,
      myRole: access.role,
      spaceRole: access.spaceRole,
      rules: await this.withLabels(mine),
      chain: explainChain(chain, ctx, titles),
    };
  }

  /**
   * `PUT /pages/:id/permissions`:整表替换。
   *
   * 整表替换而不是增量:规则集合很小(通常个位数),而增量需要客户端维护 diff ——
   * 一旦不一致就会出现"界面上删了、库里还在"的幽灵规则,那种错误极难排查。
   *
   * 清空与写入在一个事务里完成,中间不能有别的请求看到"空规则集"那一瞬
   * —— 那一瞬所有页面都会回退到空间角色,等于**短暂的权限放开**。
   */
  async replaceRules(
    operator: Operator,
    pageId: string,
    input: SavePagePermissionsInput,
  ): Promise<PagePermissionsResponse> {
    const access = await this.requireCapability(operator, pageId, 'page.permission.update');

    // 去重:同一 (subjectType, subjectId) 只能有一条规则,数据库有唯一约束。
    // 在应用层先合并,给出明确的 400,而不是让数据库抛唯一冲突变成 500。
    const merged = new Map<string, SavePagePermissionsInput['rules'][number]>();
    for (const rule of input.rules) {
      if (!isPageRuleRole(rule.role)) {
        throw AppError.validation(`未知的角色:${String(rule.role)}`);
      }
      const subjectId = rule.subjectId.trim();
      if (subjectId === '') throw AppError.validation('权限主体的标识不能为空');

      const key = `${rule.subjectType}:${subjectId}`;
      if (merged.has(key)) {
        throw AppError.validation(`同一个主体只能有一条规则:${subjectId}`);
      }
      merged.set(key, { ...rule, subjectId });
    }

    const rows = [...merged.values()].map((rule) => ({
      pageId,
      subjectType: rule.subjectType,
      subjectId: rule.subjectId,
      role: rule.role,
      deny: rule.deny,
    }));

    await this.prisma.$transaction(async (tx) => {
      await tx.pagePermission.deleteMany({ where: { pageId } });
      if (rows.length > 0) {
        await tx.pagePermission.createMany({ data: rows });
      }
    });

    // 缓存立刻失效,并把这次变更写进审计 —— 「谁把谁关在门外」必须可追溯
    await this.bumpGeneration(access.page.spaceId);
    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'perm.update',
      targetType: 'page',
      targetId: pageId,
      detail: {
        spaceId: access.page.spaceId,
        ruleCount: rows.length,
        denied: rows.filter((row) => row.deny).length,
      },
    });
    return this.overview(operator, pageId);
  }

  /** 空间内可被授权的候选主体(成员 + 部门)。用于权限弹窗的自动补全。 */
  async candidates(operator: Operator, spaceId: string): Promise<PermissionSubjectCandidate[]> {
    await this.spaces.requireCapability(operator, spaceId, 'page.view');

    const members = await this.prisma.spaceMember.findMany({
      where: { spaceId },
      select: { user: { select: { id: true, name: true, department: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const users: PermissionSubjectCandidate[] = members.map((row) => ({
      subjectType: 'user',
      subjectId: row.user.id,
      label: row.user.name,
      memberCount: null,
    }));

    const counts = new Map<string, number>();
    for (const row of members) {
      const dept = row.user.department;
      if (dept === null || dept === '') continue;
      counts.set(dept, (counts.get(dept) ?? 0) + 1);
    }

    const groups: PermissionSubjectCandidate[] = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
      .map(([dept, count]) => ({
        subjectType: 'group',
        subjectId: dept,
        label: dept,
        memberCount: count,
      }));

    return [...users, ...groups];
  }

  /** 规则变更后让整个空间的权限缓存失效。 */
  async invalidateSpace(spaceId: string): Promise<void> {
    await this.bumpGeneration(spaceId);
  }

  // ==================================================================
  // 私有
  // ==================================================================

  /**
   * 走缓存算角色。
   *
   * 缓存键里带空间世代号;世代号取不到(Redis 挂了)就直接回源 ——
   * 权限判定的正确性**不能依赖缓存可用性**(§3.2:Redis 不作为唯一数据源)。
   */
  private async resolveRole(
    operator: Operator,
    page: PageAccessRow,
    spaceRole: SpaceRole,
  ): Promise<EffectiveRole> {
    const gen = await this.safeRedis((client) => client.get(generationKey(page.spaceId)));
    const cacheKey = `kc:perm:r:${page.spaceId}:${gen ?? '0'}:${operator.id}:${page.id}`;

    if (gen !== null) {
      const cached = await this.safeRedis((client) => client.get(cacheKey));
      if (cached !== null && cached !== undefined) return toEffectiveRole(cached);
    }

    const [ctx, chain] = await Promise.all([
      this.subjectContext(operator.id),
      this.chainForPage(page),
    ]);
    const role = effectiveRoleFrom(chain, ctx, spaceRole);

    if (gen !== null) {
      await this.safeRedis((client) => client.set(cacheKey, role, 'EX', CACHE_TTL_SECONDS));
    }
    return role;
  }

  /** 取某页面「根 → 自身」的规则链。一次查询拿全部祖先的规则,不逐层查。 */
  private async chainForPage(
    page: PageAccessRow,
  ): Promise<{ pageId: string; rules: PermissionRule[] }[]> {
    const ids = [...ancestorIdsOf(page.materializedPath), page.id];

    const rows = await this.prisma.pagePermission.findMany({
      where: { pageId: { in: ids } },
      orderBy: { createdAt: 'asc' },
      select: { pageId: true, subjectType: true, subjectId: true, role: true, deny: true },
    });

    const byPage = groupRules(rows);
    return ids.map((id) => ({ pageId: id, rules: byPage.get(id) ?? [] }));
  }

  /** 取用户的部门列表 —— §5.2 的判定上下文。阶段一的「用户组」就是部门。 */
  private async subjectContext(userId: string): Promise<SubjectContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { department: true },
    });
    const dept = user?.department ?? null;
    return { userId, departments: dept === null || dept === '' ? [] : [dept] };
  }

  /**
   * Redis 是**可降级**依赖:任何错误都不该让请求失败。
   * 返回 `null` 表示"没有缓存可用",调用方据此跳过缓存直接回源。
   */
  private async safeRedis<T>(work: (client: RedisService['client']) => Promise<T>): Promise<T | null> {
    try {
      return await work(this.redis.client);
    } catch {
      // 刻意不 log —— 连接层已静默,/health/ready 会如实报告 Redis 状态
      return null;
    }
  }

  private async bumpGeneration(spaceId: string): Promise<void> {
    await this.safeRedis((client) => client.incr(generationKey(spaceId)));
  }

  /** 给规则补上可读名(用户姓名 / 部门名)。 */
  private async withLabels(
    rows: readonly {
      id: string;
      subjectType: string;
      subjectId: string;
      role: string;
      deny: boolean;
    }[],
  ): Promise<PageRuleView[]> {
    const userIds = rows.filter((r) => r.subjectType === 'user').map((r) => r.subjectId);
    const users =
      userIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    return rows.map((row) => ({
      id: row.id,
      subjectType: row.subjectType === 'group' ? 'group' : 'user',
      subjectId: row.subjectId,
      subjectLabel: row.subjectType === 'user' ? (nameOf.get(row.subjectId) ?? null) : row.subjectId,
      role: isPageRuleRole(row.role) ? row.role : 'none',
      deny: row.deny,
    }));
  }
}

// ==================================================================
// 模块级纯逻辑(导出以便单测直接打)
// ==================================================================

/** 能力 → 人类可读的拒绝理由。别让用户看到「需要执行 page.edit 的权限」这种话。 */
export function describeCapability(capability: Capability): string {
  const messages: Partial<Record<Capability, string>> = {
    'page.view': '你没有查看该页面的权限',
    'page.edit': '你没有编辑该页面的权限',
    'page.create': '你没有在该位置新建页面的权限',
    'page.delete': '你没有删除该页面的权限',
    'page.restore': '你没有恢复该页面的权限',
    'page.purge': '彻底删除需要空间管理员权限',
    'page.permission.update': '修改页面权限需要空间管理员权限',
    'comment.create': '你没有在该页面留言的权限',
    'comment.resolve.own': '你没有标记评论的权限',
    'comment.resolve.any': '标记他人评论需要编辑者权限',
  };
  return messages[capability] ?? '你没有执行该操作的权限';
}

/** 缓存键的世代号。按空间粒度,见文件头说明。 */
export function generationKey(spaceId: string): string {
  return `kc:perm:gen:${spaceId}`;
}

/** 从路径切出祖先 id(不含自身)。与 page.service.ts 的同名函数语义一致。 */
export function ancestorIdsOf(path: string): string[] {
  const ids = path.split('/').filter((segment) => segment !== '');
  return ids.slice(0, -1);
}

/** 把「某页面 id → 规则数组」的行集合归并成 Map。 */
export function groupRules(
  rows: readonly {
    pageId: string;
    subjectType: string;
    subjectId: string;
    role: string;
    deny: boolean;
  }[],
): Map<string, PermissionRule[]> {
  const map = new Map<string, PermissionRule[]>();
  for (const row of rows) {
    const list = map.get(row.pageId) ?? [];
    list.push(toRule(row));
    map.set(row.pageId, list);
  }
  return map;
}

function toRule(row: {
  subjectType: string;
  subjectId: string;
  role: string;
  deny: boolean;
}): PermissionRule {
  return {
    subjectType: row.subjectType === 'group' ? 'group' : 'user',
    subjectId: row.subjectId,
    role: isPageRuleRole(row.role) ? row.role : 'none',
    deny: row.deny,
  };
}

/** 在内存里沿父子指针走出一条链(根 → 自身)。树已全部加载,不需要再查库。 */
export function chainOf(
  pageId: string,
  nodes: readonly { id: string; parentId: string | null }[],
  rulesByPage: ReadonlyMap<string, PermissionRule[]>,
): { pageId: string; rules: PermissionRule[] }[] {
  const parentOf = new Map(nodes.map((row) => [row.id, row.parentId]));

  const ids: string[] = [];
  let cursor: string | null = pageId;

  // 上限纯属防御:数据损坏成环时不要死循环,退化成"按已走过的路径判定"
  for (let guard = 0; cursor !== null && guard < 1000; guard += 1) {
    ids.unshift(cursor);

    const parent = parentOf.get(cursor);
    // ⚠️ 这里必须区分三种情况,不能一把 `?? null` 掩盖过去:
    //   - 没有父(parent === null):到了根,正常结束;
    //   - **父不在本次加载的集合里**(!parentOf.has):调用方只加载了部分节点,
    //     到此为止 —— 继续上溯会凭空造出一个"没有规则的幽灵祖先"插进链里;
    //   - 有父:继续。
    if (parent === null || parent === undefined) break;
    if (!parentOf.has(parent)) break;
    cursor = parent;
  }

  return ids.map((id) => ({ pageId: id, rules: rulesByPage.get(id) ?? [] }));
}

/**
 * 生成给 UI 看的推导链(「有效权限是从哪一层来的」)。
 *
 * ⚠️ 这是判定逻辑的**第二份实现**,第一份是 shared 的 `resolveRoleAlongChain`。
 * 之所以敢这么写,是因为单测里钉了一条等价性断言:
 * `explainChain(chain, ctx).at(-1)?.role` 必须与 `effectiveRoleFrom(chain, ctx, spaceRole)`
 * 在 deny / 无规则 / 命中三种情形下**完全一致**。两份实现一旦漂移,测试立刻失败。
 *
 * 注意 `explainChain` 不接收 spaceRole —— 它只描述"页面链上发生了什么",
 * 最后的兜底(链上无任何规则时回退空间角色)由调用方展示。
 */
export function explainChain(
  chain: readonly { pageId: string; rules: readonly PermissionRule[] }[],
  ctx: SubjectContext,
  titles: readonly { title: string; depth: number }[] = [],
): ChainStep[] {
  const steps: ChainStep[] = [];

  for (const [index, node] of chain.entries()) {
    const meta = titles[index];
    const base = {
      pageId: node.pageId,
      pageTitle: meta?.title ?? '',
      depth: meta?.depth ?? index,
    };

    const matched = node.rules.filter((rule) =>
      rule.subjectType === 'user'
        ? rule.subjectId === ctx.userId
        : ctx.departments.includes(rule.subjectId),
    );

    // 拒绝优先:短路。后面的层不再看 —— 与纯函数的行为严格一致。
    if (matched.some((rule) => rule.deny)) {
      steps.push({ ...base, role: 'none', source: 'deny' });
      return steps;
    }

    if (matched.length === 0) {
      steps.push({ ...base, role: null, source: 'none' });
      continue;
    }

    // 同层多规则:user 比 group 更具体,排在后面被选中(与纯函数的 bySpecificity 一致)
    const winner = [...matched]
      .sort((a, b) => (a.subjectType === 'user' ? 1 : 0) - (b.subjectType === 'user' ? 1 : 0))
      .at(-1);
    steps.push({ ...base, role: toEffectiveRole(winner?.role), source: 'rule' });
  }

  return steps;
}

/** 供 `visibility` 之外的调用点复用:把空间角色收敛成合法枚举。 */
export function normalizeSpaceRole(value: string | null | undefined): SpaceRole | null {
  return toSpaceRole(value);
}
