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
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

type UserViewRow = Prisma.UserGetPayload<{ select: typeof USER_VIEW_SELECT }>;

/** 一页最多返回多少人。组织架构页是"翻着看"的场景,不是无限滚动。 */
const USER_PAGE_SIZE = 200;

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

  /** 人员列表,含每人的组织归属路径。 */
  async listUsers(query?: string): Promise<OrgUserView[]> {
    const keyword = query?.trim();

    const rows = await this.prisma.user.findMany({
      where:
        keyword === undefined || keyword === ''
          ? {}
          : {
              OR: [
                { employeeNo: { contains: keyword, mode: 'insensitive' } },
                { name: { contains: keyword, mode: 'insensitive' } },
              ],
            },
      select: {
        ...USER_VIEW_SELECT,
        assignments: { select: { node: { select: { id: true, materializedPath: true } } } },
      },
      orderBy: [{ employeeNo: 'asc' }],
      take: USER_PAGE_SIZE,
    });

    return this.toViews(rows);
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

    const created = await this.prisma.user
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

    if (input.nodeIds !== undefined && input.nodeIds.length > 0) {
      await this.replaceAssignments(created.id, input.nodeIds);
    }

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'org.user.create',
      targetType: 'user',
      targetId: created.id,
      detail: { employeeNo, name: created.name },
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

  /** 设置某人的组织归属(**多归属**,整表替换)。 */
  async setAssignments(
    operator: Actor,
    userId: string,
    input: SetUserAssignmentsInput,
  ): Promise<OrgUserView> {
    this.requireSuperAdmin(operator);

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user === null) throw AppError.notFound();

    // 校验节点都存在且未删除 —— 归属指向一个已删节点会让"组织范围"算错
    if (input.nodeIds.length > 0) {
      const found = await this.prisma.node.count({
        where: { id: { in: input.nodeIds }, deletedAt: null },
      });
      if (found !== new Set(input.nodeIds).size) {
        throw AppError.validation('归属目标里有不存在或已删除的节点');
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
    input: { name: string; parentId: string | null; ownerId?: string },
  ): Promise<{ id: string; title: string }> {
    const name = input.name.trim();
    if (name === '') throw AppError.validation('名称不能为空');

    await this.permissions.requireCreateUnder(operator, input.parentId);

    let parentPath: string | null = null;
    let depth = 0;
    if (input.parentId !== null) {
      const parent = await this.prisma.node.findUnique({
        where: { id: input.parentId },
        select: { materializedPath: true, depth: true, deletedAt: true },
      });
      if (parent === null || parent.deletedAt !== null) throw AppError.notFound();
      parentPath = parent.materializedPath;
      depth = parent.depth + 1;
    }

    const id = randomId();
    const ownerId = input.ownerId ?? operator.id;

    // 指定的所有者也必须存在且在职 —— 把所有权交给一个离职账号,这个节点就废了
    await this.assertActiveUser(ownerId);

    const row = await this.prisma.$transaction(async (tx) => {
      const last = await tx.node.findFirst({
        where: { parentId: input.parentId, deletedAt: null },
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
      await this.permissions.requireManage(operator, nodeId);
    }

    await this.assertActiveUser(ownerId);

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
   * Excel 导入是**增量**语义(§8.5):表格里没写与"要删掉归属"无法区分,
   * 所以调岗必须两步 —— 导入新归属 + 界面移出旧归属。而在 v2.4 之前,
   * 第二步只能到「人员管理 → 设置归属」里整表替换,**看不到"这个节点下都有谁"**。
   * 这个接口就是补上那一步。
   *
   * ## 两条刻意的设计
   *
   * 1. **读全员开放** —— 与整棵树一致(§5.3 规则一)。组织架构本来就是公开的,
   *    把"这个部门有谁"藏起来在这个系统里没有意义(树本身就全员可见)。
   *    写操作才需要 `canManage`。
   *
   * 2. **分成 `direct` / `inherited` 两段** —— 只有**直接**归属在这个节点上的人
   *    能从这里移出;归属在子孙节点上的人要移出,得到对应子孙上去操作。
   *    不分段的话,管理员会试图"从技术部移出后端组的人" —— 而那件事
   *    应该在后端组那一层做。
   */
  async members(operator: Actor, nodeId: string): Promise<NodeMembersResponse> {
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
      canManage: operator.isSuperAdmin || canManagePure(operator, chain),
    };
  }

  /**
   * 能加到这个节点下的人 —— **已按操作者的组织范围过滤**。
   *
   * 为什么不复用授权候选人(`PermissionService.candidates`):两者的**门槛不同**。
   * 授权的要求是 `canManage`(超管不在此列 —— 他改不了别人的内容权限),
   * 而成员维护对**超管是放行的**(组织架构本来就归他管,何况他的组织归属
   * 可能是空的,过不了范围检查)。
   * 复用的话会出现「超管能改成员、但候选列表是空的」这种自相矛盾的界面。
   *
   * 规则与 `ownerCandidates` 一致:门槛用同一套,候选人用同一套过滤。
   */
  async memberCandidates(operator: Actor, nodeId: string): Promise<GrantCandidate[]> {
    const { chain } = await this.permissions.chainOf(nodeId);
    this.requireManageMember(operator, chain);

    const rows = await this.prisma.user.findMany({
      // 只列在职的:把人加进组织,却给他一个已离职/已停用的账号,没有意义
      where: { status: 'active' },
      select: {
        id: true,
        name: true,
        employeeNo: true,
        assignments: { select: { node: { select: { materializedPath: true } } } },
      },
      orderBy: [{ employeeNo: 'asc' }],
    });

    const toCandidate = (row: (typeof rows)[number]): GrantCandidate => ({
      userId: row.id,
      name: row.name,
      employeeNo: row.employeeNo,
      scopePaths: row.assignments.map((assignment) => assignment.node.materializedPath),
    });

    // 超管不受组织范围约束 —— 见方法注释。
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
   * 拉进自己组。超管豁免 —— 他的组织归属可能是空的,而且组织架构维护本就是他的职责。
   *
   * ⚠️ 这里**不做"移出旧归属"** —— 调岗是两步,第二步由管理员显式选择在哪一层移出。
   * 顺手替人删归属会让"他到底还在不在原部门"变得不可预测。
   */
  async addMember(operator: Actor, nodeId: string, userId: string): Promise<NodeMembersResponse> {
    const { chain, row } = await this.permissions.chainOf(nodeId);
    this.requireManageMember(operator, chain);

    await this.assertActiveUser(userId);

    if (!operator.isSuperAdmin && !(await this.permissions.isInOperatorScope(operator.id, userId))) {
      const who = await this.pluckUser(userId);
      throw AppError.forbidden(`不能把「${who.name}」加到这里 —— 他不在你的组织范围内`);
    }

    const existing = await this.prisma.orgAssignment.findUnique({
      where: { userId_nodeId: { userId, nodeId } },
      select: { userId: true },
    });
    // 幂等:已经是成员就什么都不做(也不要重复记审计,否则日志会被刷屏)
    if (existing !== null) return this.members(operator, nodeId);

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

    return this.members(operator, nodeId);
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
  async removeMember(operator: Actor, nodeId: string, userId: string): Promise<NodeMembersResponse> {
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

    return this.members(operator, nodeId);
  }

  /** 谁能改这个节点的成员 —— 该节点或其上级的所有者,以及超管。 */
  private requireManageMember(operator: Actor, chain: Parameters<typeof canManagePure>[1]): void {
    if (operator.isSuperAdmin) return;
    if (!canManagePure(operator, chain)) {
      throw AppError.forbidden('只有该节点或其上级的所有者才能调整成员');
    }
  }

  // ================================================================
  // 辅助
  // ================================================================

  /** 组织范围下拉用:一级 / 二级节点的路径 + 该范围内的人数。 */
  async scopeOptions(): Promise<OrgScopeOption[]> {
    const nodes = await this.prisma.node.findMany({
      where: { deletedAt: null, depth: { lte: 1 } },
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
    const { chain } = await this.permissions.chainOf(nodeId);
    if (chain.ancestors.length === 0) {
      this.requireSuperAdmin(operator);
    } else {
      await this.permissions.requireManage(operator, nodeId);
    }

    const myScopes = await this.permissions.scopePathsOf(operator.id);
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { materializedPath: true },
    });
    if (node === null) throw AppError.notFound();

    // 范围取"我的组织范围"与"该节点子树"的**交集** —— 候选人既要是我的下属,
    // 也要是这个节点相关的人。
    const rows = await this.prisma.user.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        name: true,
        employeeNo: true,
        assignments: { select: { node: { select: { materializedPath: true } } } },
      },
      orderBy: [{ employeeNo: 'asc' }],
    });

    return rows
      .filter((row) =>
        row.assignments.some(
          (assignment) =>
            isWithinSubtree(assignment.node.materializedPath, node.materializedPath) ||
            myScopes.some((scopePath) =>
              isWithinSubtree(assignment.node.materializedPath, scopePath),
            ),
        ),
      )
      .map((row) => ({
        userId: row.id,
        name: row.name,
        employeeNo: row.employeeNo,
        scopePaths: row.assignments.map((a) => a.node.materializedPath),
      }));
  }

  /** 供导入服务复用:整表替换某人的归属。 */
  async replaceAssignments(userId: string, nodeIds: readonly string[]): Promise<void> {
    const unique = [...new Set(nodeIds)];
    await this.prisma.$transaction(async (tx) => {
      await tx.orgAssignment.deleteMany({ where: { userId } });
      if (unique.length > 0) {
        await tx.orgAssignment.createMany({
          data: unique.map((nodeId) => ({ userId, nodeId })),
        });
      }
    });
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
    return rows.map((row) => toView(row, row.assignments.map((a) => a.node), titles));
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
