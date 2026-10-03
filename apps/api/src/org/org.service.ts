/**
 * 组织架构服务 —— DESIGN.md §4 / §5 / §6.2。
 *
 * v2.0 新增。它承担的是**旧 SpaceService 的位置**,但职责不同:
 *
 *   旧:空间的增删改 + 成员邀请 + 角色管理(按角色等级)
 *   新:组织节点的建立 + 人员的预置 + 归属的维护 + 所有者的任命
 *
 * ⚠️ 这里**没有"成员"概念**。人员通过 `org_assignments` 表达"他在组织里的位置",
 * 而"他能改什么"完全由 `PermissionService` 的所有者/祖先链/授权三关系决定。
 * 不要把"归属"和"权限"混在一起 —— 归属是组织事实,权限是判定结果。
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  INITIAL_PASSWORD,
  type Actor,
  type CreateUserInput,
  type GrantCandidate,
  type NodeMembersResponse,
  type NodeMemberView,
  type OrgScopeOption,
  type OrgUserListResponse,
  type OrgUserView,
  type SetUserAssignmentsInput,
  type UpdateUserInput,
  canManage as canManagePure,
  isWithinSubtree,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { PasswordService } from '../auth/password.service.js';
import { AppError } from '../common/errors/app-error.js';
import {
  idsOfPath,
  pathOfChild,
  pathOfRoot,
  renderPath,
  subtreePrefix,
} from '../common/node-path.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../permission/permission.service.js';

const USER_VIEW_SELECT = {
  id: true,
  employeeNo: true,
  name: true,
  status: true,
  isSuperAdmin: true,
  mustChangePassword: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

type UserViewRow = Prisma.UserGetPayload<{ select: typeof USER_VIEW_SELECT }>;

/**
 * 人员列表的分页参数。
 *
 * 默认 50 是给管理表格用的(一屏大约看得到这么多);
 * 上限 500 是给**下拉选择器**用的 —— 「任命负责人」那个下拉需要尽可能全的名单,
 * 它没法翻页。超过 500 人的组织会看到明确的截断提示,而不是静默少人。
 *
 * ⚠️ 游标是 `employeeNo`(唯一且有升序索引)。不用 offset:按工号排序时,
 * offset 分页在有人新建账号之后会**跳过或重复**记录。
 */
const USER_DEFAULT_PAGE_SIZE = 50;
const USER_MAX_PAGE_SIZE = 500;

@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly passwords: PasswordService,
  ) {}

  // ================================================================
  // 人的列表
  // ================================================================

  /**
   * 人员列表,含每人的组织归属路径。
   *
   * ⚠️ **超管专属**(v2.4 补上校验)。此前这条接口**根本没有判权** —— 任何
   * 登录用户都能拿到全公司名册,而文档 §6.2 一直写的是超管。加
   * `mustChangePassword` 的时候才暴露出来:那个字段等于一份"谁的密码还是
   * 123456"的**目标清单**,对非管理员绝不该可见。
   *
   * 那"这个部门里有谁"要不要公开?要 —— 但它走的是
   * `GET /nodes/:id/members`(v2.4,读全员开放)。公开的是**组织归属**,
   * 不是账号状态与登录时间。
   */
  async listUsers(
    operator: Actor,
    query?: string,
    cursor?: string,
    limit?: number,
  ): Promise<OrgUserListResponse> {
    this.requireSuperAdmin(operator);

    const keyword = query?.trim();
    const size = Math.min(
      Math.max(Math.trunc(limit ?? USER_DEFAULT_PAGE_SIZE), 1),
      USER_MAX_PAGE_SIZE,
    );

    const filter: Prisma.UserWhereInput =
      keyword === undefined || keyword === ''
        ? {}
        : {
            OR: [
              { employeeNo: { contains: keyword, mode: 'insensitive' } },
              { name: { contains: keyword, mode: 'insensitive' } },
            ],
          };

    // 游标与搜索条件必须用 AND 组合。写成"有游标就覆盖掉 where"会让
    // 第二页悄悄丢掉搜索条件 —— 于是搜索"张"之后翻页,出现的是一整页无关的人。
    const pageWhere: Prisma.UserWhereInput =
      cursor === undefined || cursor === ''
        ? filter
        : { AND: [filter, { employeeNo: { gt: cursor } }] };

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where: pageWhere,
        select: {
          ...USER_VIEW_SELECT,
          assignments: { select: { node: { select: { id: true, materializedPath: true } } } },
        },
        orderBy: [{ employeeNo: 'asc' }],
        // 多取一条:它的存在就说明还有下一页。比再发一次 count 便宜。
        take: size + 1,
      }),
      this.prisma.user.count({ where: filter }),
    ]);

    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;

    return {
      // toViews 是异步的(它要解析归属路径)。忘了 await 的话返回的是
      // 一个 Promise 被塞进数组字段 —— 而 TS 只会在两边类型都对不上时才报错。
      users: await this.toViews(page),
      total,
      nextCursor: hasMore ? (page.at(-1)?.employeeNo ?? null) : null,
    };
  }

  /**
   * 建人(**预置,不是注册**)。
   *
   * 初始密码是内置常量 `123456`(§6.1.2),并强制 `mustChangePassword = true` ——
   * 这两件事必须一起做:只设初始密码而不强制改密,等于全员同密码上线。
   */
  async createUser(operator: Actor, input: CreateUserInput): Promise<OrgUserView> {
    this.requireSuperAdmin(operator);

    const employeeNo = input.employeeNo.trim();
    if (employeeNo === '') throw AppError.validation('工号不能为空');

    const passwordHash = await this.passwords.hash(INITIAL_PASSWORD);

    /*
      ⚠️ v5.45(P0 修复):归属的**存在性**要在写库**之前**查。
      =
      `CreateUserDto.nodeIds` 只校验 UUID 格式(`@IsUUID('4')`),
      不校验那个节点真的存在 —— 而 `setAssignments` 走的是另一条路、
      它校验。同一族 DTO 两套标准,结果就是:传一个格式合法但不存在的
      节点 id,会一路走到 `createMany` 才撞外键。

      ⚠️ 提前查不是为了"给个好看的报错",而是为了**让失败发生在写之前**:
      建号已经落库、归属没建成、审计也还没写的时候,库里就多了一个
      无人认领的账号(原版就是这个顺序)。
    */
    const nodeIds = input.nodeIds === undefined ? [] : [...new Set(input.nodeIds)];
    if (nodeIds.length > 0) {
      const found = await this.prisma.node.count({ where: { id: { in: nodeIds } } });
      if (found !== nodeIds.length) {
        throw AppError.validation('设置的归属里有不存在的节点,请刷新后重试');
      }
    }

    // 建号与建归属在**同一个事务**里 —— 原来分两步,第二步失败会留下孤儿账号。
    const created = await this.prisma
      .$transaction(async (tx) => {
        const row = await tx.user
          .create({
            data: {
              employeeNo,
              name: input.name.trim(),
              passwordHash,
              mustChangePassword: true,
            },
            select: USER_VIEW_SELECT,
          })
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) {
              throw AppError.validation(`工号「${employeeNo}」已存在`);
            }
            throw error;
          });
        if (nodeIds.length > 0) {
          await this.replaceAssignmentsIn(tx, row.id, nodeIds);
        }
        return row;
      })
      .catch((error: unknown) => {
        // 事务内抛的 AppError 原样透出;只有唯一键冲突需要翻译成人话。
        if (isUniqueViolation(error)) {
          throw AppError.validation(`工号「${employeeNo}」已存在`);
        }
        throw error;
      });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.user.create',
      targetType: 'user',
      targetId: created.id,
      // ⚠️ v5.45:带上 `nodeIds` —— 原来只有工号与姓名,
      // 于是"建号时同时指定了归属"这件事在审计里查不到归属到了哪些节点。
      detail: { employeeNo, name: created.name, nodeIds },
    });

    return (await this.viewOf(created.id)) ?? toView(created, []);
  }

  /** 改姓名 / 改状态(在职 / 停用 / 离职)。 */
  async updateUser(operator: Actor, userId: string, input: UpdateUserInput): Promise<OrgUserView> {
    this.requireSuperAdmin(operator);

    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, isSuperAdmin: true },
    });
    if (existing === null) throw AppError.notFound();

    // 别把最后一个在职的超管改成离职 —— 那会把系统锁死,没人能维护组织架构了。
    if (input.status !== undefined && input.status !== 'active' && existing.isSuperAdmin) {
      const activeAdmins = await this.prisma.user.count({
        where: { isSuperAdmin: true, status: 'active', id: { not: userId } },
      });
      if (activeAdmins === 0) {
        throw AppError.validation('这是最后一个在职的管理员,不能停用或标记离职');
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    });

    // 离职 / 停用要**立刻踢下线** —— 否则他手里那个会话还能继续用。
    // (守卫每次请求都会查 status,所以这里不必真的删会话行;但删掉更干净,
    //  也让"当前在线人数"这类统计不会把离职的人算进去。)
    if (input.status !== undefined && input.status !== 'active') {
      await this.prisma.session.deleteMany({ where: { userId } });
    }

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.user.update',
      targetType: 'user',
      targetId: userId,
      detail: { name: input.name ?? null, status: input.status ?? null },
    });

    return (await this.viewOf(userId)) ?? toView(await this.pluckUser(userId), []);
  }

  /**
   * 把某人的密码**打回初始值**(超管)。
   *
   * 这是系统里唯一一个正规的「我进不去自己的账号」出口。少了它,忘密码的人
   * 只能靠运维进容器跑脚本直接改库 —— 那不是运维该干的事,而且不留任何痕迹。
   *
   * 三件事必须一起做,少一件都会留下说不清的状态:
   *
   *   1. 哈希写回 `INITIAL_PASSWORD`(`123456`,§6.1.2 的内置常量)
   *   2. `mustChangePassword = true` —— 否则等于把密码**永久**设成了 123456
   *   3. **吊销他全部会话** —— 否则他手上那个标签页还能继续用,
   *      而管理员以为"他已经进不来了"
   *
   * ## 为什么不用管已签发的一次性凭证
   *
   * 重置一个还没激活的账号时,他上一步拿到的 `setupToken` 在 10 分钟内仍然可用。
   * 这**不构成额外暴露**:他能拿旧凭证改密码,也能拿 `123456` 重新登一次换张新的。
   * 未激活账号的初始密码本来就等同于公开信息 —— 那正是这套强制改密机制
   * 存在的前提(§6.1.2「已知风险」)。为了它引入"凭证版本号",等于给认证主链路
   * 加一条谁都不敢动的耦合。
   *
   * 真正需要收回的东西(已发出的**会话**)重置是收回了的,见上面第 3 条。
   */
  async resetPassword(operator: Actor, userId: string): Promise<OrgUserView> {
    this.requireSuperAdmin(operator);

    // 能点这个按钮就说明他已经登进来了 —— 能登进来的人不需要重置自己。
    // 允许它只会制造一次手滑:他会立刻被踢下线,然后要用 123456 登回来、
    // 还得再改一遍密码。想改自己的密码,走「修改密码」。
    if (userId === operator.id) {
      throw AppError.validation(
        '不能重置自己的密码 —— 你现在是登录状态,要改自己的密码请用「修改密码」',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, employeeNo: true, name: true, status: true },
    });
    if (existing === null) throw AppError.notFound();

    // 重置一个登不进来的人的密码是白做工,而且会让人以为"重置了怎么还是登不上"。
    // 直接把真正的原因说出来。
    if (existing.status !== 'active') {
      const label = existing.status === 'departed' ? '已离职' : '已停用';
      throw AppError.validation(
        `${existing.name}当前是「${label}」,重置密码也登不进来。要先把他改回「在职」`,
      );
    }

    const passwordHash = await this.passwords.hash(INITIAL_PASSWORD);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: true },
      }),
      // 立刻踢下线。「重置密码」在管理员的认知里就是"我把他踢出去了",
      // 留着会话行会让这句话不成立。
      this.prisma.session.deleteMany({ where: { userId } }),
    ]);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.user.reset_password',
      targetType: 'user',
      targetId: userId,
      // 只记工号与姓名。密码是内置常量,但**任何密码都不进审计** ——
      // 审计日志的读者范围比密码的知情范围大得多。
      detail: { employeeNo: existing.employeeNo, name: existing.name },
    });

    return (await this.viewOf(userId)) ?? toView(await this.pluckUser(userId), []);
  }

  /** 设置某人的组织归属(**多归属**,整表替换)。 */
  async setAssignments(
    operator: Actor,
    userId: string,
    input: SetUserAssignmentsInput,
  ): Promise<OrgUserView> {
    this.requireSuperAdmin(operator);

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user === null) throw AppError.notFound();

    // 校验节点都存在 —— 归属指向一个不存在的节点会让"组织范围"算错
    if (input.nodeIds.length > 0) {
      const found = await this.prisma.node.count({
        where: { id: { in: input.nodeIds } },
      });
      if (found !== new Set(input.nodeIds).size) {
        throw AppError.validation('归属目标里有不存在的节点');
      }
    }

    await this.replaceAssignments(userId, input.nodeIds);

    // 归属变了 → 授权范围跟着变 → 缓存必须失效。
    // 保守起见失效**全部**一级节点的世代号:一个人的归属可能横跨多个部门。
    await this.invalidateAllGenerations();

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.assignment.set',
      targetType: 'user',
      targetId: userId,
      detail: { nodeCount: input.nodeIds.length },
    });

    return (await this.viewOf(userId)) ?? toView(await this.pluckUser(userId), []);
  }

  // ================================================================
  // 组织节点
  // ================================================================

  /**
   * 建组织节点。
   *
   * `parentId = null` 就是建**部门**(一级节点),此时:
   *   - 只有超管能建(组织架构是管理层的事)
   *   - 必须指定部长为所有者 —— 否则这个部门**没人能管**
   *
   * `parentId !== null` 时走 `requireCreateUnder`:能改该父节点、或归属在它范围内的人都能建。
   */
  async createOrgNode(
    operator: Actor,
    input: { name: string; parentId: string | null },
  ): Promise<{ id: string; title: string }> {
    const name = input.name.trim();
    if (name === '') throw AppError.validation('名称不能为空');

    await this.permissions.requireCreateUnder(operator, input.parentId);

    const id = randomId();
    /*
      ⚠️ v5.45(P0 修复):所有者**固定为操作者本人**,不再接受外部指定。
      理由见 DTO 里那段注释(建组是"谁建谁负责",任命所有权走
      `setOwner` —— 那条路上有组织范围校验)。
    */
    const ownerId = operator.id;

    /*
      ⚠️⚠️ 父路径必须在事务**内**读 —— 与 `NodeService.create` 和 `move` 同一条原则。
      事务外读到的只是个快照:若并发把父节点移到别处,这里会用过期路径算出
      一个"父子关系对、路径却对不上"的新节点,祖先链从此断裂
      (权限按路径前缀找祖先,链断 = 判权错误,受限继承也可能丢)。
      详见 `node.service.ts` move() 里对"为什么 Serializable 救不了"的说明。
    */
    const row = await this.prisma.$transaction(async (tx) => {
      let parentPath: string | null = null;
      let depth = 0;
      if (input.parentId !== null) {
        const fresh = await tx.node.findUnique({
          where: { id: input.parentId },
          select: { materializedPath: true, depth: true },
        });
        if (fresh === null) throw AppError.notFound();
        parentPath = fresh.materializedPath;
        depth = fresh.depth + 1;
      }

      const last = await tx.node.findFirst({
        where: { parentId: input.parentId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });

      return tx.node.create({
        data: {
          id,
          parentId: input.parentId,
          kind: 'space',
          title: name,
          position: (last?.position ?? -1) + 1,
          depth,
          materializedPath: parentPath === null ? pathOfRoot(id) : pathOfChild(parentPath, id),
          ownerId,
          createdBy: operator.id,
          updatedBy: operator.id,
        },
        select: { id: true, title: true },
      });
    });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.create',
      targetType: 'node',
      targetId: row.id,
      detail: { parentId: input.parentId, kind: 'space', title: row.title, ownerId },
    });

    return row;
  }

  /**
   * 任命 / 变更所有者。
   *
   * 门槛是**该节点的祖先链所有者**(`canManage`)—— 也就是"部长任命组长"。
   * 注意 `canManage` 通常也包含节点自己的所有者,但对一级节点(部门)来说,
   * 改所有者的只能是超管:否则部长可以把自己改成任何人,等于自授权力。
   */
  async setOwner(operator: Actor, nodeId: string, ownerId: string): Promise<void> {
    const { chain, row } = await this.permissions.chainOf(nodeId);

    const isRoot = chain.ancestors.length === 0;
    if (isRoot) {
      this.requireSuperAdmin(operator);
    } else {
      // ⚠️ v4.9:写路径用不判读的那一道 —— 否则"改成功了却回 404"。
      // (下面那句 assertActiveUser 才是这里真正的另一道闸。)
      await this.permissions.requireManageForWrite(operator, nodeId, '修改所有者');
    }

    await this.assertActiveUser(ownerId);

    /*
      ⚠️ v5.45(P0 修复):**任命所有者受组织范围约束**(§5.3 规则三),
      **但超管豁免**。
      =
      这一句以前**不存在**,而同一份代码里 `ownerCandidates` 的注释
      明确写着这条规则,并且还写着「与 `setOwner` 必须用同一套规则」。
      **规则写清楚了,只实现在了读路径** —— 于是改一下请求体就能越权任命。
      2026-10-04 在生产服务器实测确认:后端组组长(KC003)把 owner 改成
      市场部部长(KC005)返回 **204**,随后 KC005 对该子树 `canManage=true`,
      并**真的删掉了整个组**(`removedCount: 4`,v2.12 起物理删除、不可恢复)。

      ⚠️⚠️ **超管必须豁免,这一点是实测逼出来的,不是我一开始想到的。**
      第一次实现没给豁免,理由是「与 `addMember` 同一口径」。部署后
      `verify-org` 立刻报出一条真实回归:

        ✗ 超管能改一级部门的所有者 → 204   (实际 403)

      原因:超管**按设计没有组织归属**(种子刻意不给 `assignedTo`,
      §5.3 讨论过这一点),于是 `isInOperatorScope(超管, 任何人)`
      恒为 false —— 那会把「超管给顶层节点换部长」这条**逃生通道**
      彻底堵死。而它是 `REMAINING.md` 明确登记的方案:
      部长离职且账号停用时,超管靠它换人。

      所以这里的口径是:
        · **超管换部长**(一级节点)→ 豁免,那是组织架构操作;
        · **超管改二级组的所有者**→ 那一支本来就要求
          `requireManageForWrite`,他不是该节点所有者就 403,不受影响;
        · **其他人一律走范围校验** —— 越权的那条路(组长派跨部门的人)
          仍然被堵住,因为组长不是超管。

      与 `addMember` 的差别不是"不一致",而是**职责不同**:
      成员归属调整不需要超管亲自做(他也没有归属范围可谈),
      而换部长是组织架构层面的动作,只有超管能做。
    */
    if (
      !operator.isSuperAdmin &&
      !(await this.permissions.isInOperatorScope(operator.id, ownerId))
    ) {
      const who = await this.pluckUser(ownerId);
      throw AppError.forbidden(
        `不能把「${who.name}」任命为这里的所有者 —— 他不在你的组织范围内。` +
          '若确实需要他接手,先在「人员 → 设置归属」里把他放进这个部门,再来任命。',
      );
    }

    await this.prisma.node.update({
      where: { id: nodeId },
      data: { ownerId, version: { increment: 1 }, updatedBy: operator.id },
    });

    // 所有者变了 → 这一整棵子树的权限都变了 → 失效
    await this.permissions.invalidateByNode(nodeId);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.owner.update',
      targetType: 'node',
      targetId: nodeId,
      detail: { title: row.title, from: row.ownerId, to: ownerId },
    });
  }

  // ================================================================
  // 节点成员(组织归属)· v2.4
  // ================================================================

  /**
   * 一个节点下都有谁。
   *
   * ## 为什么需要它
   *
   * Excel 导入是**增量**语义(§8.4):表格里没写与"要删掉归属"无法区分,
   * 所以调岗必须两步 —— 导入新归属 + 界面移出旧归属。而在 v2.4 之前,
   * 第二步只能到「人员管理 → 设置归属」里整表替换,**看不到"这个节点下都有谁"**。
   * 这个接口就是补上那一步。
   *
   * ## 两条刻意的设计
   *
   * 1. **默认读全员开放** —— 与整棵树一致(§5.3 规则一)。组织架构本来就是公开的,
   *    把"这个部门有谁"藏起来在这个系统里没有意义(树本身就全员可见)。
   *    写操作才需要 `canManage`。
   *
   *    ⚠️ 上面那句"与整棵树一致"里藏着一个坑:树从 v2.12 起**会做可见性过滤**,
   *    而这条接口当时没跟着收口 —— 于是受限节点的成员列表对任何登录用户
   *    返回 200,而树、详情、正文、导出全回 404。见方法体第一行的说明。
   *
   * 2. **分成 `direct` / `inherited` 两段** —— 只有**直接**归属在这个节点上的人
   *    能从这里移出;归属在子孙节点上的人要移出,得到对应子孙上去操作。
   *    不分段的话,管理员会试图"从技术部移出后端组的人" —— 而那件事
   *    应该在后端组那一层做。
   */
  async members(operator: Actor, nodeId: string): Promise<NodeMembersResponse> {
    // ⚠️ 先过读判定(v2.15 补)。原来直接 `chainOf` 就开工 ——
    // 而 chainOf 不判可见性,于是**受限节点的成员列表对任何人都返回 200**:
    // 既确认了节点存在,又把"这个部门有谁"给出去了。
    // 其余读取路径(详情/正文/导出/评论)都回 404,只有这条漏着 ——
    // 一致性本身就是安全性质:一条不一致的路径就是一条侧信道。
    await this.permissions.requireRead(operator, nodeId);
    return this.buildMembersView(operator, nodeId);
  }

  /**
   * 组装成员响应,**不带读判定**。
   *
   * ⚠️ 单独分出来是给 `addMember` / `removeMember` 做返回值用的。
   * 它们**先写库、再组装响应**,而写操作的门槛是 `canManage`(该节点或
   * 其上级的所有者),它可以**严格宽于**读判定:超管就是这种情况 ——
   * 在"自己没拥有、没创建、也不在名单里"的**受限**节点上,他改得动,
   * 却读不到。
   *
   * 原来这里直接调 `this.members()`,于是超管的写入**成功了却收到 404**:
   * 界面报错、而库里已经改了 —— 用户只能进数据库修。
   * `replaceReaders` 早就踩过同一个坑,原则写在
   * `permission.service.ts` 的 `buildReadersView` 上:
   *
   *   **写操作的成功与否,不能取决于"写完之后还能不能读"。**
   *
   * 安全上这不放宽任何东西:能走到这里的调用方刚刚都通过了
   * `requireManageMember`(比 `requireRead` 严),而 `members()` 那条
   * 公开读路径仍然照旧先过 `requireRead`。
   */
  private async buildMembersView(operator: Actor, nodeId: string): Promise<NodeMembersResponse> {
    const { chain, row } = await this.permissions.chainOf(nodeId);
    const prefix = subtreePrefix(row.materializedPath);

    // ① 这棵子树内的全部归属行
    const inside = await this.prisma.orgAssignment.findMany({
      where: { OR: [{ nodeId }, { node: { materializedPath: { startsWith: prefix } } }] },
      select: { userId: true, node: { select: { id: true, materializedPath: true } } },
    });

    const userIds = [...new Set(inside.map((item) => item.userId))];

    // ② 这些人的**全部**归属(不止这棵子树)
    //    用来回答"把他从这儿移出之后,他还剩下什么身份" —— 这个问题不回答清楚,
    //    管理员会以为移出一条归属等于把人清出了公司。
    const allRows =
      userIds.length === 0
        ? []
        : await this.prisma.orgAssignment.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, node: { select: { id: true, materializedPath: true } } },
          });

    const [users, titles] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: USER_VIEW_SELECT,
        orderBy: [{ employeeNo: 'asc' }],
      }),
      this.titleMapOf([...inside, ...allRows].map((item) => item.node.materializedPath)),
    ]);

    const groupByUser = (
      rows: readonly { userId: string; node: { id: string; materializedPath: string } }[],
    ): Map<string, { id: string; materializedPath: string }[]> => {
      const map = new Map<string, { id: string; materializedPath: string }[]>();
      for (const item of rows) {
        const bucket = map.get(item.userId) ?? [];
        bucket.push(item.node);
        map.set(item.userId, bucket);
      }
      return map;
    };

    const insideByUser = groupByUser(inside);
    const allByUser = groupByUser(allRows);

    const views: NodeMemberView[] = users.map((user) => {
      const insideNodes = insideByUser.get(user.id) ?? [];
      const insideIds = new Set(insideNodes.map((node) => node.id));
      return {
        userId: user.id,
        name: user.name,
        employeeNo: user.employeeNo,
        status: toUserStatus(user.status),
        memberNodeIds: insideNodes.map((node) => node.id),
        memberPaths: insideNodes.map((node) => renderPath(node.materializedPath, titles)),
        otherPaths: (allByUser.get(user.id) ?? [])
          .filter((node) => !insideIds.has(node.id))
          .map((node) => renderPath(node.materializedPath, titles)),
        isOwnerHere: row.ownerId === user.id,
        isAncestorOwner: chain.ancestors.some((ancestor) => ancestor.ownerId === user.id),
      };
    });

    // 直接归属在这个节点上的人 —— 只有他们能从这里移出
    const directIds = new Set(
      inside.filter((item) => item.node.id === nodeId).map((item) => item.userId),
    );

    return {
      nodeId,
      title: row.title,
      direct: views.filter((view) => directIds.has(view.userId)),
      inherited: views.filter((view) => !directIds.has(view.userId)),
      // ⚠️ v5.43:与 requireManageMember 同一套口径(P0-4),不再有超管旁路。
      // 界面用它决定"成员"按钮要不要可点 —— 与服务端判定同源,不会自相矛盾。
      canManage: canManagePure(operator, chain),
    };
  }

  /**
   * 能加到这个节点下的人 —— **已按操作者的组织范围过滤**。
   *
   * 为什么不复用授权候选人(`PermissionService.candidates`):两者的**候选来源**不同。
   * 授权要求 `canManage`,而超管在 `canManage` 里没有旁路(P0-4 已收归),
   * 所以两条路径的门槛现在**一致**了 —— 差别只剩候选过滤的宽严:
   * 授权按"操作者的组织范围"过滤,成员维护按"该节点子树"过滤。
   *
   * 规则与 `ownerCandidates` 一致:门槛用同一套,候选人用同一套过滤。
   */
  async memberCandidates(operator: Actor, nodeId: string): Promise<GrantCandidate[]> {
    // ⚠️ v2.16 补读判定。`requireManageMember` 是**纯判定**,它不查节点、
    // 也不看可见性 —— 于是受限节点的候选人名单(以及"这个节点存在"这件事)
    // 会对任何登录用户返回 200,而其余读取路径都回 404。
    // 一条不一致的路径就是一条侧信道(§5.6)。
    await this.permissions.requireRead(operator, nodeId);
    const { chain } = await this.permissions.chainOf(nodeId);
    this.requireManageMember(operator, chain);

    const rows = await this.prisma.user.findMany({
      // 只列在职的:把人加进组织,却给他一个已离职/已停用的账号,没有意义
      where: { status: 'active' },
      select: {
        id: true,
        name: true,
        employeeNo: true,
        status: true,
        assignments: { select: { node: { select: { materializedPath: true } } } },
      },
      orderBy: [{ employeeNo: 'asc' }],
    });

    const toCandidate = (row: (typeof rows)[number]): GrantCandidate => ({
      userId: row.id,
      name: row.name,
      employeeNo: row.employeeNo,
      // v5.44:补状态。上面 `where: { status: 'active' }` 已保证恒为在职,
      // 但类型要求这个字段,而"筛选条件保证"不等于"类型告诉调用方这件事"。
      status: toUserStatus(row.status),
      scopePaths: row.assignments.map((assignment) => assignment.node.materializedPath),
    });

    // 超管不受组织范围约束 —— 但注意这只是**候选列表**的宽严,
    // 他能不能改这些成员由 requireManageMember 决定(v5.43 已收掉那条旁路)。
    // 保留这个分支是为了界面可用性:超管的组织归属通常是空的,
    // 若也按范围过滤,他会看到一个空列表,却连一个人都加不了。
    if (operator.isSuperAdmin) return rows.map(toCandidate);

    const myScopes = await this.permissions.scopePathsOf(operator.id);
    if (myScopes.length === 0) return [];

    return rows
      .filter((row) =>
        row.assignments.some((assignment) =>
          myScopes.some((scopePath) =>
            isWithinSubtree(assignment.node.materializedPath, scopePath),
          ),
        ),
      )
      .map(toCandidate);
  }

  /**
   * 把某人加到某个节点下(**追加**一条归属,不是整表替换)。
   *
   * 与授权一样受**组织范围约束**(§5.3 规则三):组长不该能把别的部门的人
   * 拉进自己组。
   *
   * ⚠️ **v5.43 收掉了这里的超管豁免**(P0-4)。原来写的是
   * `!operator.isSuperAdmin && !(await isInOperatorScope(...))`。
   *
   * 为什么连**范围检查**也要收:门槛已经由 `requireManageMember` 统一成
   * 「该节点或其上级的所有者」,超管不再有旁路。那么给他开范围豁免,
   * 只会造成一种自相矛盾的局面:**他能通过这个接口把任意部门的任何人
   * 加进任意节点** —— 只要他 somehow 成了那个节点的所有者(比如
   * `setOwner` 之后),他的组织范围本该限制他,现在却完全不受限。
   * 一旦收口到 `canManage`,范围检查就应当**对所有人一视同仁**,
   * 否则"组织范围"这道横向防线上就多了一个洞。
   *
   * ⚠️ 这里**不做"移出旧归属"** —— 调岗是两步,第二步由管理员显式选择在哪一层移出。
   * 顺手替人删归属会让"他到底还在不在原部门"变得不可预测。
   */
  async addMember(operator: Actor, nodeId: string, userId: string): Promise<NodeMembersResponse> {
    const { chain, row } = await this.permissions.chainOf(nodeId);
    this.requireManageMember(operator, chain);

    await this.assertActiveUser(userId);

    if (!(await this.permissions.isInOperatorScope(operator.id, userId))) {
      const who = await this.pluckUser(userId);
      throw AppError.forbidden(`不能把「${who.name}」加到这里 —— 他不在你的组织范围内`);
    }

    const existing = await this.prisma.orgAssignment.findUnique({
      where: { userId_nodeId: { userId, nodeId } },
      select: { userId: true },
    });
    // 幂等:已经是成员就什么都不做(也不要重复记审计,否则日志会被刷屏)
    if (existing !== null) return this.buildMembersView(operator, nodeId);

    await this.prisma.orgAssignment.create({ data: { userId, nodeId } });

    // 归属变了 → 授权范围跟着变 → 缓存必须失效(与 setAssignments 同理)
    await this.invalidateAllGenerations();

    const who = await this.pluckUser(userId);
    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.member.add',
      targetType: 'node',
      targetId: nodeId,
      detail: { title: row.title, userId, name: who.name, employeeNo: who.employeeNo },
    });

    return this.buildMembersView(operator, nodeId);
  }

  /**
   * 把某人从某个节点**移出**(删掉这一条归属)。
   *
   * ⚠️ **移出归属不改变所有权。** 若他正是这个节点的所有者(组长),移出之后
   * 他仍然是所有者 —— 两件事是分开的。界面上会提示,服务端不拦:
   * 人事上"调岗但还没换组长"是真实存在的过渡状态,替管理员拦下来反而办不成事。
   *
   * 真正会变的是他的**组织范围**:范围缩小后,他能授权的对象变少。
   * 这一点也写在界面的提示里。
   */
  async removeMember(
    operator: Actor,
    nodeId: string,
    userId: string,
  ): Promise<NodeMembersResponse> {
    const { chain, row } = await this.permissions.chainOf(nodeId);
    this.requireManageMember(operator, chain);

    const removed = await this.prisma.orgAssignment.deleteMany({ where: { userId, nodeId } });
    if (removed.count === 0) {
      throw AppError.validation('这个人并没有直接归属在这个节点上');
    }

    await this.invalidateAllGenerations();

    const who = await this.pluckUser(userId);
    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.member.remove',
      targetType: 'node',
      targetId: nodeId,
      detail: {
        title: row.title,
        userId,
        name: who.name,
        employeeNo: who.employeeNo,
        // 他是不是这个节点的所有者 —— 追责时这一条最要紧
        wasOwner: row.ownerId === userId,
      },
    });

    return this.buildMembersView(operator, nodeId);
  }

  /**
   * 谁能改这个节点的成员 —— **只有该节点或其上级的所有者**。
   *
   * ⚠️ **v5.43 收掉了这里的超管例外**(P0-4)。原来第一行是
   * `if (operator.isSuperAdmin) return;`,于是超管能增删任何节点的成员,
   * 而同一条既定原则在 `requireCreateUnder` 里已经收掉了(他只能建顶层节点,
   * 其余只读)—— 同一个"超管能做什么"的口径散在两处且互相矛盾。
   *
   * 为什么必须收:`canManage` 是**纯函数,无超管分支**(`permission.service.ts`
   * 的设计如此),所以整个权限模型的口径是「所有者及其上级」。
   * 成员维护属"写",留着一个超管旁路,等于在唯一的越权口子上开口子。
   *
   * **取舍(用户已确认)**:收掉后,若部长离职且账号被停用,暂时没人能改该部门成员。
   * 逃逸通道仍在 —— 超管可以对顶层节点 `setOwner` 换一位部长,再由新部长管成员。
   * 也就是说:超管不是"不能管",而是"不能绕过所有者直接改"。
   */
  private requireManageMember(operator: Actor, chain: Parameters<typeof canManagePure>[1]): void {
    if (!canManagePure(operator, chain)) {
      throw AppError.forbidden('只有该节点或其上级的所有者才能调整成员');
    }
  }

  // ================================================================
  // 辅助
  // ================================================================

  /**
   * 组织范围下拉用:一级 / 二级节点的路径 + 该范围内的人数。
   *
   * ⚠️ v2.16 补权限判定。此前这条接口**根本没有判权** —— 任何登录用户
   * 都能拿到全公司的部门 / 组清单与人数。它唯一的调用方是
   * 「人员管理 → 设置归属」与「建组」两个**超管界面**(见 `useOrgScopes`),
   * 而文档 §5.3 一直把这个能力写在 `is_super_admin` 名下。
   *
   * 判成超管而不是"按可见性过滤"的理由:它返回的是**组织架构的全貌**
   * (含每个部门的人数),而组织架构本就归超管维护;按可见性过滤反而会
   * 造出一份"缺了几行"的架构图,让设置归属的人给出错误的归属。
   */
  async scopeOptions(operator: Actor): Promise<OrgScopeOption[]> {
    this.requireSuperAdmin(operator);

    const nodes = await this.prisma.node.findMany({
      where: { depth: { lte: 1 } },
      select: { id: true, title: true, depth: true, materializedPath: true },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
    });

    const assignments = await this.prisma.orgAssignment.findMany({
      select: { node: { select: { materializedPath: true } } },
    });

    const titles = new Map<string, string>();
    for (const node of nodes) titles.set(node.id, node.title);

    return nodes.map((node) => ({
      nodeId: node.id,
      path: renderPath(node.materializedPath, titles),
      // 该范围内的人数 = 归属落在这个节点子树里的人
      memberCount: assignments.filter((assignment) =>
        isWithinSubtree(assignment.node.materializedPath, node.materializedPath),
      ).length,
    }));
  }

  /**
   * 能担任**某个节点所有者**的候选人。
   *
   * 与授权候选人是同一套规则:必须落在操作者的组织范围内(§5.3 规则三)。
   * 否则部长可以把别的部门的人任命成自己组的组长。
   */
  async ownerCandidates(operator: Actor, nodeId: string): Promise<GrantCandidate[]> {
    // ⚠️ 与 `setOwner` 必须用**同一套规则**,否则会出现「看得到候选人但改不了」
    // (或反过来),而超管换部长正是靠这两条一起工作的。
    //
    // v2.16:先过读判定。这条与 memberCandidates 是同一处漏收口 ——
    // 受限节点的 owner 是谁、候选人有哪些,对未授权的人都不该可见。
    await this.permissions.requireRead(operator, nodeId);
    const { chain } = await this.permissions.chainOf(nodeId);
    if (chain.ancestors.length === 0) {
      this.requireSuperAdmin(operator);
    } else {
      await this.permissions.requireManageForWrite(operator, nodeId, '查看可任命的人选');
    }

    const myScopes = await this.permissions.scopePathsOf(operator.id);
    // 一次取全:既要知道子树路径用于范围过滤,也要知道**当前负责人是否还在职**
    // (决定要不要放宽范围)。两次查会让人以为它们是两件事。
    const current = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { materializedPath: true, ownerId: true },
    });
    if (current === null) throw AppError.notFound();

    /*
      ⚠️ v5.44(P0-5 的延伸):候选人范围**从「必须有归属」放宽为「在职即可」**。
      =
      原来的判据是"有归属,且归属落在该节点子树或我的范围内"。它有一个
      **把自己锁死**的后果:

        部长离职 → 他名下的一级部门**没有新部长** → 谁能当新部长?
        那些**还没被设进任何组织归属**的在职员工 —— 他们 `assignments` 是空的,
        原来那个 filter 直接把他们全滤掉,于是候选人列表**空掉**,
        界面上"更换所有者为…"是一个**只有标题的空下拉框**。

      也就是说:组织架构越是"缺人"的时候,这个功能越不可用 ——
      而那正是最需要它的时刻。这是"范围约束"被用成了"必须有关系"。

      为什么不索性全公司的人都能选:那会让部长能把**市场部**的人拉来当自己组的
      组长,§5.3 规则三(横向防越权)就没了。

      所以这一版的判据是 **在职 ∧ (有相关归属 ∨ 本节点已经缺人)**:
        · 正常情况下(有在职负责人在)规则照旧,范围约束仍然有效;
        · 节点缺人时,任何**在职**账号都可以被选进来 ——
          这是"填上这个坑"的唯一途径,而选人这件事仍然由
          `setOwner` 的门槛(超管 / 祖先链所有者)把着。
      离职与停用**一律不出现**(下面 select 里的 status 过滤),
      它们的 id 也不该出现在下拉框里 —— 让管理员选一个必然失败选项。
    */
    const all = await this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        employeeNo: true,
        status: true,
        assignments: { select: { node: { select: { materializedPath: true } } } },
      },
      orderBy: [{ employeeNo: 'asc' }],
    });

    // **已经在任的人不算"缺人"** —— 范围约束照旧,不然就等于对每个节点都放开了。
    const needReplacement =
      (all.find((row) => row.id === current.ownerId)?.status ?? 'active') !== 'active';

    return all
      .filter((row) => row.status === 'active')
      .filter(
        (row) =>
          needReplacement ||
          row.assignments.some(
            (assignment) =>
              isWithinSubtree(assignment.node.materializedPath, current.materializedPath) ||
              myScopes.some((scopePath) =>
                isWithinSubtree(assignment.node.materializedPath, scopePath),
              ),
          ),
      )
      .map((row) => ({
        userId: row.id,
        name: row.name,
        employeeNo: row.employeeNo,
        // v5.44:带上状态。筛选后这里恒为 'active',但**类型上仍要带** ——
        // 界面要用它标注(见 GrantDialog 的置灰逻辑),而 `GrantCandidate`
        // 是三个候选列表共用的类型,不能只在某一条路径上给。
        status: toUserStatus(row.status),
        scopePaths: row.assignments.map((a) => a.node.materializedPath),
      }));
  }

  /** 供导入服务复用:整表替换某人的归属。 */
  async replaceAssignments(userId: string, nodeIds: readonly string[]): Promise<void> {
    await this.prisma.$transaction((tx) => this.replaceAssignmentsIn(tx, userId, nodeIds));
  }

  /**
   * `replaceAssignments` 的事务内版本 —— **接受一个已有的事务客户端**。
   *
   * ⚠️ v5.45(P0 修复)新增,只为让 `createUser` 能把「建号 + 建归属」
   * 放进**同一个事务**。
   *
   * 原来 `createUser` 是两步:先在事务外 `user.create`,再调
   * `replaceAssignments`(它自带一个事务)。第二步失败时第一步**已经落库**,
   * 而异常又发生在 `recordAudit` **之前** —— 于是库里留下一个
   * 「有账号、零组织归属、审计里查不到」的孤儿。
   *
   * 复现(真实可验):`POST /admin/users` 传一个格式合法但**不存在**的
   * `nodeIds` → `create` 成功 → `createMany` 撞外键 P2003 → 500,
   * 而那个工号已经在库里了。
   */
  private async replaceAssignmentsIn(
    tx: Prisma.TransactionClient,
    userId: string,
    nodeIds: readonly string[],
  ): Promise<void> {
    const unique = [...new Set(nodeIds)];
    await tx.orgAssignment.deleteMany({ where: { userId } });
    if (unique.length > 0) {
      await tx.orgAssignment.createMany({
        data: unique.map((nodeId) => ({ userId, nodeId })),
      });
    }
  }

  /**
   * 失效**全部**一级节点的权限缓存。
   *
   * 只在"组织归属变更"时用:一个人的归属可能横跨多个部门,
   * 逐个算受影响的一级节点反而容易漏。
   */
  async invalidateAllGenerations(): Promise<void> {
    const roots = await this.prisma.node.findMany({
      where: { parentId: null },
      select: { id: true },
    });
    await Promise.all(roots.map((root) => this.permissions.invalidate(root.id)));
  }

  private requireSuperAdmin(operator: Actor): void {
    if (!operator.isSuperAdmin) {
      throw AppError.forbidden('只有管理员能维护组织架构与人员');
    }
  }

  private async assertActiveUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (user === null) throw AppError.notFound();
    if (user.status !== 'active') {
      throw AppError.validation('不能把权限交给已停用或已离职的账号');
    }
  }

  private async pluckUser(userId: string): Promise<UserViewRow> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_VIEW_SELECT,
    });
    if (row === null) throw AppError.notFound();
    return row;
  }

  private async viewOf(userId: string): Promise<OrgUserView | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...USER_VIEW_SELECT,
        assignments: { select: { node: { select: { id: true, materializedPath: true } } } },
      },
    });
    if (row === null) return null;
    return (await this.toViews([row]))[0] ?? null;
  }

  /** 批量把归属路径渲染成 `技术部 / 后端组`。一条查询取全部标题,不做 N+1。 */
  private async toViews(
    rows: readonly (UserViewRow & {
      assignments: { node: { id: string; materializedPath: string } }[];
    })[],
  ): Promise<OrgUserView[]> {
    const titles = await this.titleMapOf(
      rows.flatMap((row) => row.assignments.map((assignment) => assignment.node.materializedPath)),
    );
    return rows.map((row) =>
      toView(
        row,
        row.assignments.map((a) => a.node),
        titles,
      ),
    );
  }

  /**
   * 从一组物化路径收集涉及的节点 id,一次查出 `id → 标题`。
   *
   * 路径里已经含全部祖先 id,所以调用方**不需要**额外补祖先 ——
   * 这一点让 `members()` 只查一次就能渲染出 `技术部 / 后端组` 这样的完整路径。
   */
  private async titleMapOf(paths: readonly string[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const path of paths) {
      for (const id of idsOfPath(path)) ids.add(id);
    }
    if (ids.size === 0) return new Map();

    const nodes = await this.prisma.node.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, title: true },
    });
    return new Map(nodes.map((node) => [node.id, node.title]));
  }
}

// ==================================================================
// 纯函数 / 小工具
// ==================================================================

function randomId(): string {
  // 与 node.service 一致:主键在应用侧生成,因为物化路径里含自身 id,
  // 一次 INSERT 就能写对,不需要"先插再更新路径"两步。
  return randomUUID();
}

function toView(
  row: UserViewRow,
  nodes: readonly { id: string; materializedPath: string }[],
  titles: ReadonlyMap<string, string> = new Map(),
): OrgUserView {
  return {
    id: row.id,
    employeeNo: row.employeeNo,
    name: row.name,
    status: toUserStatus(row.status),
    isSuperAdmin: row.isSuperAdmin,
    scopePaths: nodes.map((node) => renderPath(node.materializedPath, titles)),
    scopeNodeIds: nodes.map((node) => node.id),
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

function toUserStatus(value: string): OrgUserView['status'] {
  if (value === 'active' || value === 'disabled' || value === 'departed') return value;
  return 'disabled';
}

/** 判断是否是唯一约束冲突(Prisma 的 P2002)。用鸭子类型,不依赖生成的错误类。 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === 'P2002';
}
