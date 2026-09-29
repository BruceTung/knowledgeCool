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
  type NodeAccessLists,
  type NodeGrantsResponse,
  type NodeReadersResponse,
  type ReaderCandidate,
  type SaveNodeGrantsInput,
  type SaveNodeReadersInput,
  canEdit as canEditPure,
  canGrantTo,
  canManage as canManagePure,
  canManageReaders as canManageReadersPure,
  canRead as canReadPure,
  isWithinSubtree,
  toNodeVisibility,
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
  /**
   * 能不能读(v2.12)。
   *
   * ⚠️ 读不到时**必须回 404 而不是 403** —— 403 等于确认「这里有个你看不见的
   * 东西」,而保密的意义就在于不确认它的存在。
   * (v2.0~v2.11 期间 errors.ts 特意不用 404 掩盖 FORBIDDEN,那是因为当时读
   *  对全员开放、没有"存在但读不到"的资源。受限节点让那个前提不再成立。)
   */
  canRead: boolean;
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
  // v2.12 保密能力:判定「能读吗」要用到这两列
  visibility: true,
  createdBy: true,
} satisfies Prisma.NodeSelect;

type JudgeRow = Prisma.NodeGetPayload<{ select: typeof JUDGE_SELECT }>;

/** 链上的一环只要这几列。与 JUDGE_SELECT 分开,免得取链时多查一堆用不上的字段。 */
const CHAIN_SELECT = {
  id: true,
  ownerId: true,
  title: true,
  depth: true,
  visibility: true,
  createdBy: true,
} satisfies Prisma.NodeSelect;

type ChainRow = Prisma.NodeGetPayload<{ select: typeof CHAIN_SELECT }>;

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
  async chainOf(nodeId: string): Promise<{ chain: Chain; row: JudgeRow }> {
    const self = await this.pluck(nodeId);
    const prefixes = prefixPathsOf(self.materializedPath);

    const rows = await this.prisma.node.findMany({
      where: { materializedPath: { in: prefixes } },
      select: CHAIN_SELECT,
      orderBy: { depth: 'asc' },
    });

    const ancestors: ChainNode[] = rows.filter((row) => row.id !== self.id).map(toChainNode);
    return {
      chain: {
        self: toChainNode(self),
        ancestors,
      },
      row: self,
    };
  }

  /**
   * 判定某人某节点。带 Redis 缓存 —— **Redis 不可用时自动回源,判定正确性不依赖它**。
   *
   * ⚠️ v2.12 起**没有 `allowDeleted` 了**。回收站被整体移除,节点只有
   * "存在"与"不存在"两种状态,不再需要"对已删除的节点判定"这条分支 ——
   * 于是缓存里也不会再出现"删除前 / 删除后"两种语义并存的问题。
   */
  async access(operator: Actor, nodeId: string): Promise<AccessContext> {
    const { chain, row } = await this.chainOf(nodeId);

    const compute = async (): Promise<{
      canRead: boolean;
      canEdit: boolean;
      canManage: boolean;
    }> => {
      const granted = await this.grantedUserIdsOf(nodeId);
      return {
        // 只在链上真的存在受限节点时才去查名单 —— 绝大多数节点是 public,
        // 那种情况下这一条不产生任何查询(判定的热路径不能多一次往返)。
        canRead: canReadPure(operator, chain, await this.accessListsOf(chain)),
        canEdit: canEditPure(operator, chain, granted),
        canManage: canManagePure(operator, chain),
      };
    };

    const rootId = rootIdOf(chain);

    // ⚠️ 世代号**只读一次**,并且这一个值贯穿"读缓存"与"写缓存"两端。
    //
    // 原实现在 writeCache 内部又读了一次 —— 如果 compute() 期间恰好有 INCR
    // 落进来(有人改了权限),就会把"失效之前算出来的那个结果"写进**新世代**,
    // 于是它躲过了这次失效,并且存活满 30 秒。表现是"权限已经改完了,
    // 但某个人还能改",**静默越权**,而且不会报任何错。
    //
    // 用同一个世代号之后:INCR 之后这次的写入会落进旧世代 —— 不会再有人读它,
    // 自然作废。这是世代号方案本来就该有的用法。
    const generation = await this.generationOf(rootId);

    if (generation !== null) {
      const cached = await this.readCacheAt(generation, operator.id, nodeId);
      if (cached !== null) return { nodeId, chain, row, ...cached };
    }

    const result = await compute();
    if (generation !== null) {
      await this.writeCacheAt(generation, operator.id, nodeId, result);
    }
    return { nodeId, chain, row, ...result };
  }

  /**
   * 断言可读(v2.12)。
   *
   * ⚠️ 读不到时抛的是 **404 而不是 403**。403 会确认「这里确实有个东西,
   * 只是你看不见」—— 对保密来说那就是泄露。见 AccessContext.canRead 的说明。
   */
  async requireRead(operator: Actor, nodeId: string): Promise<AccessContext> {
    const context = await this.access(operator, nodeId);
    if (!context.canRead) throw AppError.notFound();
    return context;
  }

  /** 断言可改。**这里是唯一入口** —— 调用点不要自己判断。 */
  async requireEdit(operator: Actor, nodeId: string): Promise<AccessContext> {
    const context = await this.access(operator, nodeId);
    // 先判读:读不到的节点连"你没有编辑权限"都不该说 —— 那句话本身就承认了它存在。
    if (!context.canRead) throw AppError.notFound();
    if (!context.canEdit) throw AppError.forbidden('你没有编辑该节点的权限');
    return context;
  }

  /** 断言可管(决定这个节点还有谁能改)。 */
  async requireManage(operator: Actor, nodeId: string): Promise<AccessContext> {
    const context = await this.access(operator, nodeId);
    if (!context.canRead) throw AppError.notFound();
    if (!context.canManage) {
      throw AppError.forbidden('只有该节点或其上级的所有者才能修改权限');
    }
    return context;
  }

  /**
   * 能否在 `parentId` 下新建(§5.3 能力对照)。
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
      // ⚠️ 乐观锁必须在**事务内**认领,写法是"带 version 条件 + 检查影响行数"
      // (比较并交换),而不是事务外比一下、事务内无条件 +1。
      //
      // 原写法是 TOCTOU:两个管理员同时改同一个节点的授权名单时,两次都在事务外
      // 通过了 version 比较,然后各自在事务里删表、重建、+1 —— 后写的那次
      // **静默覆盖**前一次,而两个人都以为保存成功了。
      // 这正是 version 这个号存在的目的,所以必须在这一步就抢。
      const claimed = await tx.node.updateMany({
        where: { id: nodeId, version: input.version },
        data: { version: { increment: 1 } },
      });
      if (claimed.count === 0) throw AppError.versionConflict();

      // 增量的理由与顺序:先认领(CAS),再整表替换名单。
      // 两者在同一个事务里,不存在"名单被替换了但 version 没动"的窗口。
      await tx.nodeGrant.deleteMany({ where: { nodeId } });
      if (targetIds.length > 0) {
        await tx.nodeGrant.createMany({
          data: targetIds.map((userId) => ({ nodeId, userId, grantedBy: operator.id })),
        });
      }
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
  // 可见性与读者名单(v2.12)
  // ================================================================

  /**
   * 一个节点的可见性 + 读者名单。
   *
   * `inheritedFrom` 是**最容易被误解的一点**:节点显示"受限",但所有者可能
   * 从没在这里设过 —— 限制是从祖先继承的。不说明的话,管理员会在这个节点上
   * 反复尝试改回公开,而那做不到(只能去祖先那一层改)。
   */
  async readersOverview(operator: Actor, nodeId: string): Promise<NodeReadersResponse> {
    // ⚠️ 先过读判定。**这是最容易漏的一条** —— 它看起来是"管理界面用的",
    // 而管理界面只有能管的人才打得开。但接口是公开的:不过这一关的话,
    // 任何登录用户都能对任意 nodeId 拿到 200,等于确认了节点存在,
    // 并且**把读者名单(保密名单本身)读走** —— 那是最不该泄露的一份数据。
    // (v2.15 文档对账时实测发现:受限节点上详情/正文/导出/评论全 404,
    //  而这条返回 200。属于"读取路径收口"漏掉的一条。)
    await this.requireRead(operator, nodeId);
    return this.buildReadersView(operator, nodeId);
  }

  /**
   * 组装可见性 + 读者名单响应,**不带读判定**。
   *
   * ⚠️ 单独分出来是因为 `replaceReaders` 要用它做返回值 ——
   * 写入方**刚刚**已经通过了 `canManageReaders`(创建者或所有者),
   * 而它的响应若还要过一次读判定,就会出现**"改动已生效、但接口报错"**:
   * 真机上就是这样把自己锁住的(设成受限且名单为空 → 响应组装 404 →
   * 界面报错、而库里已经改了,用户只能进数据库修)。
   *
   * **原则:写操作的成功与否,不能取决于"写完之后还能不能读"。**
   */
  private async buildReadersView(operator: Actor, nodeId: string): Promise<NodeReadersResponse> {
    const { chain, row } = await this.chainOf(nodeId);

    const rows = await this.prisma.nodeReader.findMany({
      where: { nodeId },
      select: { userId: true, grantedBy: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const briefs = await this.userBriefMap([
      ...rows.map((item) => item.userId),
      ...rows.map((item) => item.grantedBy),
    ]);

    // 祖先链上**离它最近**的受限节点(ancestors 是根→父,所以反过来找第一个)
    const nearest = [...chain.ancestors].reverse().find((node) => node.visibility === 'restricted');

    return {
      nodeId,
      visibility: toNodeVisibility(row.visibility),
      readers: rows.map((item) => {
        const brief = briefs.get(item.userId);
        return {
          userId: item.userId,
          name: brief?.name ?? '未知',
          employeeNo: brief?.employeeNo ?? '',
          departed: brief?.status === 'departed',
          grantedByName: briefs.get(item.grantedBy)?.name ?? '未知',
          grantedAt: item.createdAt.toISOString(),
        };
      }),
      canManage: canManageReadersPure(operator, chain),
      version: row.version,
      inheritedFrom:
        nearest === undefined ? null : { nodeId: nearest.id, title: nearest.title },
    };
  }

  /**
   * 整表替换可见性与读者名单。
   *
   * 门槛是 `canManageReaders`:创建者或所有者链。
   * ⚠️ 与授权名单不同,这里**刻意不做组织范围校验** —— 受限节点的读者常常
   * 就是本部门之外的人(否则"保密"就没有意义了)。这是刻意的取舍,不是漏写。
   */
  async replaceReaders(
    operator: Actor,
    nodeId: string,
    input: SaveNodeReadersInput,
  ): Promise<NodeReadersResponse> {
    const { chain, row } = await this.chainOf(nodeId);

    if (!canManageReadersPure(operator, chain)) {
      throw AppError.forbidden('只有这个节点的创建者或所有者能管理它的可见范围');
    }

    const targetIds = [...new Set(input.userIds)];
    await this.assertAssignableUsers(targetIds);

    const nextVisibility = input.visibility ?? toNodeVisibility(row.visibility);

    await this.prisma.$transaction(async (tx) => {
      // 乐观锁:CAS,与 replaceGrants 同一套写法(带 version 条件 + 查影响行数)
      const claimed = await tx.node.updateMany({
        where: { id: nodeId, version: input.version },
        data: { version: { increment: 1 } },
      });
      if (claimed.count === 0) throw AppError.versionConflict();

      await tx.node.update({
        where: { id: nodeId },
        data: { visibility: nextVisibility, updatedBy: operator.id },
      });

      await tx.nodeReader.deleteMany({ where: { nodeId } });
      if (targetIds.length > 0) {
        await tx.nodeReader.createMany({
          data: targetIds.map((userId) => ({ nodeId, userId, grantedBy: operator.id })),
        });
      }
    });

    // 可见性/名单变了 → 这个人能不能读这个节点变了 → 缓存必须失效
    await this.invalidateByNode(nodeId);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'visibility.replace',
      targetType: 'node',
      targetId: nodeId,
      detail: { title: row.title, visibility: nextVisibility, count: targetIds.length },
    });

    return this.buildReadersView(operator, nodeId);
  }

  /**
   * 可选的读者。
   *
   * **所有在职账号**,不受组织范围限制 —— 理由与 replaceReaders 一样:
   * 受限节点的读者本来就可能是外部门的人。
   */
  async readerCandidates(operator: Actor, nodeId: string): Promise<ReaderCandidate[]> {
    // ⚠️ v2.16 补读判定。`canManageReadersPure` 是**纯判定**,不过这一关的话
    // 受限节点的读者候选会对任何登录用户返回 200 —— 与 readersOverview 是同一类漏,
    // 只是它漏的是"候选"而不是"名单本身"。
    // 先在控制器层挡住会更一致(见 permission.controller.ts 的两条 GET),
    // 但服务层也补一道:**判定属于服务,不能只靠路由那一层记得加**。
    await this.requireRead(operator, nodeId);
    const { chain } = await this.chainOf(nodeId);
    if (!canManageReadersPure(operator, chain)) return [];

    const rows = await this.prisma.user.findMany({
      where: { status: 'active' },
      select: {
        ...USER_BRIEF_SELECT,
        assignments: { select: { node: { select: { materializedPath: true } } } },
      },
      orderBy: [{ employeeNo: 'asc' }],
    });

    return rows.map((item) => ({
      userId: item.id,
      name: item.name,
      employeeNo: item.employeeNo,
      scopePaths: item.assignments.map((assignment) => assignment.node.materializedPath),
    }));
  }

  /** 名单里的人必须都存在且可用 —— 把一个离职/停用的人放进读者名单没有意义。 */
  private async assertAssignableUsers(userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    const found = await this.prisma.user.count({
      where: { id: { in: [...userIds] }, status: 'active' },
    });
    if (found !== userIds.length) {
      throw AppError.validation('名单里有不存在或已停用/离职的账号');
    }
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

  /** 按**调用方给定的**世代号读缓存 —— 世代号由 access() 读一次并传下来。 */
  private async readCacheAt(
    generation: string,
    userId: string,
    nodeId: string,
  ): Promise<{ canRead: boolean; canEdit: boolean; canManage: boolean } | null> {
    try {
      const raw = await this.redis.client.get(this.cacheKey(generation, userId, nodeId));
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const value = parsed as { canRead?: unknown; canEdit?: unknown; canManage?: unknown };
      // ⚠️ 三个字段都要是布尔。少了 canRead 这一条,升级前写进去的旧缓存
      // (只有 canEdit/canManage)会被当成有效,于是**受限节点会被当成可读** ——
      // 一次静默的泄露。加上这一条之后旧缓存自然失效。
      if (
        typeof value.canRead !== 'boolean' ||
        typeof value.canEdit !== 'boolean' ||
        typeof value.canManage !== 'boolean'
      ) {
        return null;
      }
      return { canRead: value.canRead, canEdit: value.canEdit, canManage: value.canManage };
    } catch {
      return null;
    }
  }

  /** 按**调用方给定的**世代号写缓存。刻意不在这里再读一次世代号,理由见 access()。 */
  private async writeCacheAt(
    generation: string,
    userId: string,
    nodeId: string,
    value: { canRead: boolean; canEdit: boolean; canManage: boolean },
  ): Promise<void> {
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

  /** 取一个节点。取不到就 404 —— v2.12 起没有"已删除但仍存在"这种状态了。 */
  private async pluck(nodeId: string): Promise<JudgeRow> {
    const row = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: JUDGE_SELECT,
    });
    if (row === null) throw AppError.notFound();
    return row;
  }

  /**
   * 取链上**受限节点**的两张名单(读者 + 编辑被授权者)。
   *
   * ⚠️ 链上没有受限节点时**一个查询都不发**。读路径是热路径,
   * 而绝大多数节点是 public —— 不能为一个很少用的功能给每次判定都加一次往返。
   */
  private async accessListsOf(chain: Chain): Promise<Map<string, NodeAccessLists>> {
    const restricted = [chain.self, ...chain.ancestors].filter(
      (node) => node.visibility === 'restricted',
    );
    return this.listsOfNodeIds(restricted.map((node) => node.id));
  }

  /**
   * 批量取名单 —— 给**树的保密过滤**用。
   *
   * 树要在内存里判几千个节点,逐个节点调 access() 会退化成 N+1 次查询;
   * 这里一次把范围内所有受限节点的名单取回来。
   */
  async accessListsFor(nodeIds: readonly string[]): Promise<Map<string, NodeAccessLists>> {
    return this.listsOfNodeIds(nodeIds);
  }

  private async listsOfNodeIds(ids: readonly string[]): Promise<Map<string, NodeAccessLists>> {
    if (ids.length === 0) return new Map();
    const [readers, grants] = await Promise.all([
      this.prisma.nodeReader.findMany({
        where: { nodeId: { in: [...ids] } },
        select: { nodeId: true, userId: true },
      }),
      this.prisma.nodeGrant.findMany({
        where: { nodeId: { in: [...ids] } },
        select: { nodeId: true, userId: true },
      }),
    ]);

    const map = new Map<string, { readers: Set<string>; grantees: Set<string> }>();
    for (const id of ids) map.set(id, { readers: new Set<string>(), grantees: new Set<string>() });
    for (const item of readers) map.get(item.nodeId)?.readers.add(item.userId);
    for (const item of grants) map.get(item.nodeId)?.grantees.add(item.userId);
    return map;
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

/**
 * 把一行判定数据收敛成链上的一环。
 *
 * 自身与祖先两处共用同一个映射 —— 分开写的话,新加字段(比如 visibility)
 * 时必然漏掉一处,而漏掉的表现是"某个方向上的判定少看了一个条件",
 * 也就是静默的越权或失权。
 */
function toChainNode(row: ChainRow): ChainNode {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    depth: row.depth,
    visibility: toNodeVisibility(row.visibility),
    createdBy: row.createdBy,
  };
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
