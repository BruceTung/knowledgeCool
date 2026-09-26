/**
 * 权限判定 —— DESIGN.md §5 的服务端实现。**v2.0 起整体重写。**
 *
 * 本服务是**权限判定的唯一入口**:节点、评论、授权三处都走它,
 * **不允许任何调用点自己写 if 判断**。判定算法本身在
 * `@knowledgecool/shared` 的纯函数里(零 IO、可单测);本服务只负责三件事:
 *
 *   1. 取数据(祖先链、授权名单、组织范围)
 *   2. 调纯函数
 *   3. 缓存与失效
 *
 * ⚠️ 与旧模型的根本差别:旧模型是「五档角色 + 逐层继承 + deny 优先」,
 * 新模型是「**越靠上权限越大**」的三关系判定(所有者 / 祖先链 / 显式授权)。
 * 方向正好相反,照旧代码抄会写反。
 */

import { Injectable } from '@nestjs/common';
import {
  type Actor,
  type Chain,
  type ChainNode,
  type GrantCandidate,
  type NodeGrantsResponse,
  type SaveNodeGrantsInput,
  canEdit as canEditPure,
  canGrantTo,
  canManage as canManagePure,
  isWithinSubtree,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { AppError } from '../common/errors/app-error.js';
import { prefixPathsOf, rootIdOfPath } from '../common/node-path.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * 一次判定的结果。
 *
 * 带上 `row` 是因为调用方几乎总是紧接着就要用节点的字段
 * (标题、version、父 id……),而 `chainOf` 已经把它查出来了 ——
 * 不带上就会让调用方再查一次。
 */
export interface AccessContext {
  nodeId: string;
  chain: Chain;
  row: JudgeRow;
  canEdit: boolean;
  canManage: boolean;
}

/** 判定要用的节点字段 —— 刻意最小,但**必须含物化路径**(取祖先链要靠它)。 */
const JUDGE_SELECT = {
  id: true,
  parentId: true,
  ownerId: true,
  title: true,
  depth: true,
  materializedPath: true,
  version: true,
  deletedAt: true,
} satisfies Prisma.NodeSelect;

type JudgeRow = Prisma.NodeGetPayload<{ select: typeof JUDGE_SELECT }>;

const USER_BRIEF_SELECT = {
  id: true,
  name: true,
  employeeNo: true,
  status: true,
} satisfies Prisma.UserSelect;

type UserBrief = Prisma.UserGetPayload<{ select: typeof USER_BRIEF_SELECT }>;

/** 缓存 TTL。这是「权限变更最迟多久生效」的**上限**,不是常态(§5.5)。 */
const CACHE_TTL_SECONDS = 30;

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ================================================================
  // 取链与判定
  // ================================================================

  /**
   * 取整条祖先链(根 → 自身)。**一条查询,不递归。**
   *
   * 靠物化路径的前缀集合做 `in` 匹配。这是整棵树里唯一性能敏感的路径,
   * 所以刻意不写成递归 CTE —— 前缀集合可以在应用层一次算好,查询走索引。
   */
  async chainOf(
    nodeId: string,
    options: { allowDeleted?: boolean } = {},
  ): Promise<{ chain: Chain; row: JudgeRow }> {
    const self = await this.pluck(nodeId, options);
    const prefixes = prefixPathsOf(self.materializedPath);

    const rows = await this.prisma.node.findMany({
      where: { materializedPath: { in: prefixes }, deletedAt: null },
      select: { id: true, ownerId: true, title: true, depth: true },
      orderBy: { depth: 'asc' },
    });

    const ancestors: ChainNode[] = rows.filter((row) => row.id !== self.id);
    return {
      chain: {
        self: { id: self.id, ownerId: self.ownerId, title: self.title, depth: self.depth },
        ancestors,
      },
      row: self,
    };
  }

  /** 判定某人某节点。带 Redis 缓存 —— **Redis 不可用时自动回源,判定正确性不依赖它**。 */
  async access(operator: Actor, nodeId: string): Promise<AccessContext> {
    const { chain, row } = await this.chainOf(nodeId);
    const rootId = rootIdOf(chain);

    const cached = await this.readCache(operator.id, nodeId, rootId);
    if (cached !== null) return { nodeId, chain, row, ...cached };

    const granted = await this.grantedUserIdsOf(nodeId);
    const result = {
      canEdit: canEditPure(operator, chain, granted),
      canManage: canManagePure(operator, chain),
    };
    await this.writeCache(operator.id, nodeId, rootId, result);
    return { nodeId, chain, row, ...result };
  }

  /** 断言可改。**这里是唯一入口** —— 调用点不要自己判断。 */
  async requireEdit(operator: Actor, nodeId: string): Promise<AccessContext> {
    const context = await this.access(operator, nodeId);
    if (!context.canEdit) throw AppError.forbidden('你没有编辑该节点的权限');
    return context;
  }

  /** 断言可管(决定这个节点还有谁能改)。 */
  async requireManage(operator: Actor, nodeId: string): Promise<AccessContext> {
    const context = await this.access(operator, nodeId);
    if (!context.canManage) {
      throw AppError.forbidden('只有该节点或其上级的所有者才能修改权限');
    }
    return context;
  }

  /**
   * 能否在 `parentId` 下新建(§5.4)。
   *
   * ⚠️ 与 `canEdit` 是**两件事**:一个组员对「后端组」本身没有 `canEdit`,
   * 但他有权在它下面新建 —— 新建出来的节点归他所有。
   * 把这两件事合成一道闸,小组员就永远建不了东西。
   */
  async requireCreateUnder(operator: Actor, parentId: string | null): Promise<void> {
    if (parentId === null) {
      // 一级节点(部门)只允许管理员建 —— 组织架构是管理层的事,不是人人都能加部门。
      if (!operator.isSuperAdmin) throw AppError.forbidden('只有管理员能新建部门');
      return;
    }

    const context = await this.access(operator, parentId);
    if (context.canEdit) return;

    if (await this.isAssignedWithin(operator.id, parentId)) return;

    throw AppError.forbidden('你只能在自己所属的节点下新建');
  }

  // ================================================================
  // 组织范围(§5.3 规则三)
  // ================================================================

  /**
   * `target` 是否落在 `operator` 的**组织范围内**。
   *
   * 定义:`orgScope(user)` = 该用户所有 `org_assignments` 指向的节点及其全部后代。
   * 这条防的是横向越权 —— 组长不该能把权限给到别的部门的人。
   */
  async isInOperatorScope(operatorId: string, targetUserId: string): Promise<boolean> {
    if (operatorId === targetUserId) return true;

    const [operatorScopes, targetScopes] = await Promise.all([
      this.scopePathsOf(operatorId),
      this.scopePathsOf(targetUserId),
    ]);
    if (operatorScopes.length === 0 || targetScopes.length === 0) return false;

    return targetScopes.some((targetPath) =>
      operatorScopes.some((scopePath) => isWithinSubtree(targetPath, scopePath)),
    );
  }

  /** 某人是否归属在 `nodeId` 及其子树里 —— 用于 `requireCreateUnder`。 */
  async isAssignedWithin(userId: string, nodeId: string): Promise<boolean> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { materializedPath: true },
    });
    if (node === null) return false;

    const scopes = await this.scopePathsOf(userId);
    return scopes.some((scopePath) => isWithinSubtree(scopePath, node.materializedPath));
  }

  /** 某人的全部组织归属路径。 */
  async scopePathsOf(userId: string): Promise<string[]> {
    const rows = await this.prisma.orgAssignment.findMany({
      where: { userId },
      select: { node: { select: { materializedPath: true } } },
    });
    return rows.map((row) => row.node.materializedPath);
  }

  // ================================================================
  // 授权(替代旧的「页面权限规则」)
  // ================================================================

  /**
   * 一个节点的完整授权视图。
   *
   * **三段划分是刻意的**,UI 要分别回答「这些人为什么能改」:
   *   1. 节点所有者 —— 自己就有权
   *   2. 祖先链上的所有者 —— 有权是因为在链上,**不可移除**
   *   3. 显式授权名单 —— 只有这一段可增删
   *
   * 不分段的话,管理员会一直试图去"移除"组长的权限(一个他删不掉的东西)。
   */
  async overview(operator: Actor, nodeId: string): Promise<NodeGrantsResponse> {
    const { chain, row } = await this.chainOf(nodeId);

    const [owner, inheritedUsers, grants] = await Promise.all([
      this.userBrief(row.ownerId),
      this.userBriefs(chain.ancestors.map((node) => node.ownerId)),
      this.prisma.nodeGrant.findMany({
        where: { nodeId },
        select: { userId: true, grantedBy: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const briefs = await this.userBriefMap([
      ...grants.map((g) => g.userId),
      ...grants.map((g) => g.grantedBy),
    ]);

    return {
      nodeId,
      owner: toOwnerView(owner),
      inherited: chain.ancestors.map((ancestor, index) => ({
        nodeId: ancestor.id,
        title: ancestor.title,
        ownerId: ancestor.ownerId,
        ownerName: inheritedUsers[index]?.name ?? '未知',
        departed: inheritedUsers[index]?.status === 'departed',
      })),
      grants: grants.map((grant) => ({
        userId: grant.userId,
        name: briefs.get(grant.userId)?.name ?? '未知',
        employeeNo: briefs.get(grant.userId)?.employeeNo ?? '',
        departed: briefs.get(grant.userId)?.status === 'departed',
        grantedByName: briefs.get(grant.grantedBy)?.name ?? '未知',
        grantedAt: grant.createdAt.toISOString(),
      })),
      canManage: canManagePure(operator, chain),
      version: row.version,
    };
  }

  /**
   * 整表替换授权名单。
   *
   * ⚠️ **逐个校验被授权者在操作者组织范围内** —— 前端的候选人列表已经过滤过,
   * 但那只是便利,**不是安全边界**。这里必须再校验一次,越界直接拒绝
   * (不做"跳过非法项照样保存"的宽松处理,那会让管理员以为保存成功了)。
   */
  async replaceGrants(
    operator: Actor,
    nodeId: string,
    input: SaveNodeGrantsInput,
  ): Promise<NodeGrantsResponse> {
    const { chain, row } = await this.chainOf(nodeId);

    if (!canManagePure(operator, chain)) {
      throw AppError.forbidden('只有该节点或其上级的所有者才能修改权限');
    }
    if (row.version !== input.version) throw AppError.versionConflict();

    const targetIds = [...new Set(input.userIds)];

    for (const targetId of targetIds) {
      const inScope = await this.isInOperatorScope(operator.id, targetId);
      const allowed = canGrantTo({
        actor: operator,
        chain,
        targetUserId: targetId,
        targetInOperatorScope: inScope,
      });
      if (!allowed) {
        const who = await this.userBrief(targetId);
        throw AppError.forbidden(`不能把权限授予「${who.name}」—— 他不在你的组织范围内`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.nodeGrant.deleteMany({ where: { nodeId } });
      if (targetIds.length > 0) {
        await tx.nodeGrant.createMany({
          data: targetIds.map((userId) => ({ nodeId, userId, grantedBy: operator.id })),
        });
      }
      // 乐观锁:名单变了 version 也要动,否则两个管理员同时改会互相覆盖
      await tx.node.update({ where: { id: nodeId }, data: { version: { increment: 1 } } });
    });

    await this.invalidateByNode(nodeId);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'grant.replace',
      targetType: 'node',
      targetId: nodeId,
      detail: { title: row.title, count: targetIds.length },
    });

    return this.overview(operator, nodeId);
  }

  /**
   * 可授权的候选人 —— **已按操作者的组织范围过滤**。
   *
   * 外部门的人根本不出现在列表里,这样管理员不会「先选中、再被拒绝」。
   * 安全由 `replaceGrants` 兜底,这里只解决体验。
   */
  async candidates(operator: Actor, nodeId: string): Promise<GrantCandidate[]> {
    const chain = (await this.chainOf(nodeId)).chain;
    if (!canManagePure(operator, chain)) return [];

    const myScopes = await this.scopePathsOf(operator.id);
    if (myScopes.length === 0) return [];

    const rows = await this.prisma.user.findMany({
      where: { status: { not: 'disabled' } },
      select: {
        ...USER_BRIEF_SELECT,
        assignments: { select: { node: { select: { materializedPath: true } } } },
      },
      orderBy: [{ employeeNo: 'asc' }],
    });

    return rows
      .filter((row) =>
        row.assignments.some((assignment) =>
          myScopes.some((scopePath) =>
            isWithinSubtree(assignment.node.materializedPath, scopePath),
          ),
        ),
      )
      .map((row) => ({
        userId: row.id,
        name: row.name,
        employeeNo: row.employeeNo,
        scopePaths: row.assignments.map((assignment) => assignment.node.materializedPath),
      }));
  }

  // ================================================================
  // 缓存与失效
  // ================================================================

  /**
   * 让某个**部门(一级节点)**的权限缓存整片失效。
   *
   * 实现是世代号而不是 `SCAN` 批量删 —— 理由见 §5.5:`SCAN` 既慢,
   * 而且**可能漏**(遍历期间写入的 key 不在已扫过的桶里,会一直活到 TTL)。
   * 漏的表现是「权限已经改了,但某个人还能改」,静默越权。
   *
   * 世代号只有一处状态、一次 INCR,不存在漏删。
   */
  async invalidate(rootNodeId: string): Promise<void> {
    try {
      await this.redis.client.incr(`kc:perm:gen:${rootNodeId}`);
    } catch {
      // Redis 不可用:缓存本来就读不到,无需失效。
      // 这正是「Redis 是可降级依赖」的体现 —— 判定正确性不依赖它。
    }
  }

  /** 由节点 id 找到所属部门再失效 —— 调用点通常只知道节点 id。 */
  async invalidateByNode(nodeId: string): Promise<void> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { materializedPath: true },
    });
    if (node === null) return;
    await this.invalidate(rootIdOfPath(node.materializedPath));
  }

  private async readCache(
    userId: string,
    nodeId: string,
    rootId: string,
  ): Promise<{ canEdit: boolean; canManage: boolean } | null> {
    const generation = await this.generationOf(rootId);
    if (generation === null) return null;

    try {
      const raw = await this.redis.client.get(this.cacheKey(generation, userId, nodeId));
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const value = parsed as { canEdit?: unknown; canManage?: unknown };
      if (typeof value.canEdit !== 'boolean' || typeof value.canManage !== 'boolean') return null;
      return { canEdit: value.canEdit, canManage: value.canManage };
    } catch {
      return null;
    }
  }

  private async writeCache(
    userId: string,
    nodeId: string,
    rootId: string,
    value: { canEdit: boolean; canManage: boolean },
  ): Promise<void> {
    const generation = await this.generationOf(rootId);
    if (generation === null) return;

    try {
      await this.redis.client.set(
        this.cacheKey(generation, userId, nodeId),
        JSON.stringify(value),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch {
      // 写缓存失败不影响判定结果
    }
  }

  /** 取世代号。返回 null 表示 Redis 不可用 → 调用方跳过缓存。 */
  private async generationOf(rootId: string): Promise<string | null> {
    try {
      return (await this.redis.client.get(`kc:perm:gen:${rootId}`)) ?? '0';
    } catch {
      return null;
    }
  }

  private cacheKey(generation: string, userId: string, nodeId: string): string {
    return `kc:perm:${generation}:${userId}:${nodeId}`;
  }

  // ================================================================
  // 私有
  // ================================================================

  /**
   * 取一个节点。已删除的默认视同不存在 ——
   * 只有回收站相关操作会传 `allowDeleted`。
   */
  private async pluck(
    nodeId: string,
    options: { allowDeleted?: boolean } = {},
  ): Promise<JudgeRow> {
    const row = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: JUDGE_SELECT,
    });
    if (row === null) throw AppError.notFound();
    if (row.deletedAt !== null && options.allowDeleted !== true) throw AppError.notFound();
    return row;
  }

  private async grantedUserIdsOf(nodeId: string): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.nodeGrant.findMany({
      where: { nodeId },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  private async userBrief(userId: string): Promise<UserBrief> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_BRIEF_SELECT,
    });
    return row ?? { id: userId, name: '未知', employeeNo: '', status: 'departed' };
  }

  /** 按传入顺序返回,缺失的用占位补齐 —— 保证调用方按下标取值不会错位。 */
  private async userBriefs(userIds: readonly string[]): Promise<UserBrief[]> {
    const map = await this.userBriefMap(userIds);
    return userIds.map(
      (id) => map.get(id) ?? { id, name: '未知', employeeNo: '', status: 'departed' },
    );
  }

  private async userBriefMap(userIds: readonly string[]): Promise<Map<string, UserBrief>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: USER_BRIEF_SELECT,
    });
    return new Map(rows.map((row) => [row.id, row]));
  }
}

/** 祖先链的第一个就是根;没有祖先说明自己就是一级节点。 */
function rootIdOf(chain: Chain): string {
  return chain.ancestors[0]?.id ?? chain.self.id;
}

function toOwnerView(user: UserBrief): NodeGrantsResponse['owner'] {
  return {
    userId: user.id,
    name: user.name,
    employeeNo: user.employeeNo,
    departed: user.status === 'departed',
  };
}
