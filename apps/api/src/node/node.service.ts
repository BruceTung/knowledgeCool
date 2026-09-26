import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  type Actor,
  type CreateNodeInput,
  type MoveNodeInput,
  type NodeBreadcrumb,
  type NodeDetail,
  type NodeKind,
  type NodeTreeResponse,
  type TrashItem,
  type UpdateNodeInput,
  toNodeStatus,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { runSerializable } from '../common/db/serializable.js';
import { AppError } from '../common/errors/app-error.js';
import { idsOfPath, pathOfChild, pathOfRoot, subtreePrefix } from '../common/node-path.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../permission/permission.service.js';

/**
 * 节点服务 —— DESIGN.md §6.2 的节点接口 + §8.1/§8.2 的两个关键流程。
 *
 * ⚠️ **v2.0 起空间与页面合并为一棵树**(`page` → `node`)。
 * 因此与旧版 PageService 的三处结构性差别:
 *   1. 不再有 `spaceId` —— 树是全公司一棵,一级节点就是部门
 *   2. 鉴权全部改走 `PermissionService` 的**关系判定**(不再有角色等级)
 *   3. `tree()` 一次性返回**整棵树**(读全员开放),并附带"我哪些能改/能管"
 *
 * ## 物化路径
 *
 * 每个节点存一条 `materialized_path`,形如 `/根id/.../自身id`。它换来两件事:
 *   1. **查整棵子树**从递归 CTE 变成一次前缀扫描(`LIKE '/p1/%'`);
 *   2. **移动子树**从「递归改每一行」变成一条 UPDATE(见 `move`)。
 *
 * ## 这一节最容易做错的地方
 *
 * `move` 必须**递归重建整棵子树**的路径与深度。只改自己那一条的话,
 * 所有子孙的路径会指向旧位置 —— 权限判定(沿路径取祖先链)会跟着错,
 * 而且**当下不会报任何错**,直到某天有人发现"某篇文档莫名其妙没有权限"。
 */

/** 树查询只取渲染需要的字段 —— 不带路径,它不该出现在响应里。 */
const TREE_SELECT = {
  id: true,
  parentId: true,
  kind: true,
  title: true,
  position: true,
  depth: true,
  ownerId: true,
  createdBy: true,
} satisfies Prisma.NodeSelect;

/** 单节点详情要的字段。 */
const DETAIL_SELECT = {
  id: true,
  parentId: true,
  kind: true,
  title: true,
  position: true,
  status: true,
  version: true,
  depth: true,
  ownerId: true,
  createdBy: true,
  materializedPath: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.NodeSelect;

type DetailRow = Prisma.NodeGetPayload<{ select: typeof DETAIL_SELECT }>;

const USER_BRIEF_SELECT = {
  id: true,
  name: true,
  employeeNo: true,
  status: true,
} satisfies Prisma.UserSelect;

type UserBrief = Prisma.UserGetPayload<{ select: typeof USER_BRIEF_SELECT }>;

/** 祖先链向上走的防御上限。正常组织深度不过十几层,这是防数据损坏成环。 */
const CHAIN_GUARD = 200;

@Injectable()
export class NodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  // ==================================================================
  // 读
  // ==================================================================

  /**
   * 整棵树(不含回收站)。
   *
   * **不做权限过滤** —— 所有节点对所有登录用户可见(§5.3 规则一)。
   * 但会额外算出「我哪些能改、我哪些能管」交给前端**隐藏按钮**。
   * ⚠️ 那只是体验,服务端仍是唯一裁判。
   *
   * 权限标记是**在内存里算的**:逐节点调 `permissions.access()` 会退化成
   * N+1 查询,而树的规模是几千个节点。
   */
  async tree(operator: Actor): Promise<NodeTreeResponse> {
    const rows = await this.prisma.node.findMany({
      where: { deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: TREE_SELECT,
    });

    if (rows.length === 0) {
      return { nodes: [], editableNodeIds: [], manageableNodeIds: [] };
    }

    const nodeIds = rows.map((row) => row.id);
    const [grants, commentCounts, briefs] = await Promise.all([
      this.prisma.nodeGrant.findMany({
        where: { nodeId: { in: nodeIds } },
        select: { nodeId: true, userId: true },
      }),
      this.openCommentCounts(nodeIds),
      this.userBriefMap(rows.flatMap((row) => [row.ownerId, row.createdBy])),
    ]);

    const grantsByNode = new Map<string, Set<string>>();
    for (const grant of grants) {
      const bucket = grantsByNode.get(grant.nodeId) ?? new Set<string>();
      bucket.add(grant.userId);
      grantsByNode.set(grant.nodeId, bucket);
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    const editableNodeIds: string[] = [];
    const manageableNodeIds: string[] = [];

    for (const row of rows) {
      // 「能管」:我是这个节点的所有者,或祖先链上任一节点是所有者。
      // 用内存里的 byId 向上走,不再查库。
      let manageable = row.ownerId === operator.id;
      if (!manageable) {
        let cursor = row.parentId;
        for (let guard = 0; cursor !== null && guard < CHAIN_GUARD; guard += 1) {
          const parent = byId.get(cursor);
          if (parent === undefined) break;
          if (parent.ownerId === operator.id) {
            manageable = true;
            break;
          }
          cursor = parent.parentId;
        }
      }

      const canEdit = manageable || (grantsByNode.get(row.id)?.has(operator.id) ?? false);

      if (canEdit) editableNodeIds.push(row.id);
      if (manageable) manageableNodeIds.push(row.id);
    }

    return {
      nodes: rows.map((row) => ({
        id: row.id,
        parentId: row.parentId,
        kind: row.kind as NodeKind,
        title: row.title,
        position: row.position,
        depth: row.depth,
        ownerId: row.ownerId,
        ownerName: briefs.get(row.ownerId)?.name ?? '未知',
        openCommentCount: commentCounts.get(row.id) ?? 0,
      })),
      editableNodeIds,
      manageableNodeIds,
    };
  }

  /** 单节点详情,含从根到自身的面包屑与"我能否改/管"。 */
  async detail(operator: Actor, nodeId: string): Promise<NodeDetail> {
    const row = await this.pluck(nodeId);
    const access = await this.permissions.access(operator, nodeId);

    const [owner, creator, breadcrumb] = await Promise.all([
      this.userBrief(row.ownerId),
      this.userBrief(row.createdBy),
      this.breadcrumbOf(row.materializedPath),
    ]);

    return {
      id: row.id,
      parentId: row.parentId,
      kind: row.kind as NodeKind,
      title: row.title,
      status: toNodeStatus(row.status),
      depth: row.depth,
      version: row.version,
      ownerId: row.ownerId,
      ownerName: owner.name,
      ownerDeparted: owner.status === 'departed',
      createdByName: creator.name,
      createdByDeparted: creator.status === 'departed',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      breadcrumb,
      canEdit: access.canEdit,
      canManage: access.canManage,
    };
  }

  /**
   * 回收站:**只列我 `canEdit` 的已删子树根**。
   *
   * 只列"子树根"是因为恢复是整棵恢复的 —— 把子树里的每一层都列出来,
   * 管理员会看到一个明显重复的列表。
   */
  async trash(operator: Actor): Promise<TrashItem[]> {
    const roots = await this.prisma.node.findMany({
      where: {
        deletedAt: { not: null },
        // 子树根 = 自己没有已删除的祖先。用「父节点要么不存在要么没被删」表达。
        OR: [{ parentId: null }, { parent: { deletedAt: null } }],
      },
      orderBy: { deletedAt: 'desc' },
      select: {
        id: true,
        title: true,
        kind: true,
        parentId: true,
        materializedPath: true,
        deletedAt: true,
        deletedBy: true,
        parent: { select: { deletedAt: true } },
      },
    });

    const items: TrashItem[] = [];
    for (const root of roots) {
      const access = await this.permissions.access(operator, root.id);
      if (!access.canEdit) continue;

      const subtreeSize = await this.prisma.node.count({
        where: {
          OR: [
            { id: root.id },
            { materializedPath: { startsWith: subtreePrefix(root.materializedPath) } },
          ],
        },
      });

      items.push({
        id: root.id,
        title: root.title,
        kind: root.kind as NodeKind,
        subtreeSize,
        deletedAt: (root.deletedAt ?? new Date()).toISOString(),
        deletedByName:
          root.deletedBy === null ? '未知' : (await this.userBrief(root.deletedBy)).name,
        parentAlive: root.parent !== null && root.parent.deletedAt === null,
      });
    }

    return items;
  }

  // ==================================================================
  // 写
  // ==================================================================

  /**
   * 新建节点。
   *
   * `parentId = null` 表示建一级节点(部门)—— 只有超管能做,见 `requireCreateUnder`。
   * 新建出来的节点**归创建者所有** —— 这就是「组员建的东西归他,
   * 但他的上级链也能改」的起点。
   */
  async create(operator: Actor, input: CreateNodeInput): Promise<NodeDetail> {
    await this.permissions.requireCreateUnder(operator, input.parentId);

    let parentPath: string | null = null;
    let depth = 0;

    if (input.parentId !== null) {
      const parent = await this.pluck(input.parentId);
      parentPath = parent.materializedPath;
      depth = parent.depth + 1;
    }

    const id = randomUUID();
    const title = input.title?.trim() ?? '';
    const materializedPath = parentPath === null ? pathOfRoot(id) : pathOfChild(parentPath, id);

    const row = await this.prisma.$transaction(async (tx) => {
      const position = await nextPositionIn(tx, input.parentId);
      return tx.node.create({
        data: {
          id,
          parentId: input.parentId,
          kind: input.kind,
          title: title === '' ? defaultTitleFor(input.kind) : title,
          position,
          depth,
          materializedPath,
          // 所有者 = 创建者。上级链上的所有者天然能改它(§5.2),不需要额外写授权。
          ownerId: operator.id,
          createdBy: operator.id,
          updatedBy: operator.id,
        },
        select: DETAIL_SELECT,
      });
    });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.create',
      targetType: 'node',
      targetId: row.id,
      detail: { parentId: input.parentId, kind: input.kind, title: row.title },
    });

    return this.detail(operator, row.id);
  }

  /** 改标题 / 状态。带乐观锁。 */
  async update(operator: Actor, nodeId: string, input: UpdateNodeInput): Promise<NodeDetail> {
    await this.permissions.requireEdit(operator, nodeId);

    // ⚠️ 必须用 `Unchecked` 变体:`NodeUpdateManyMutationInput` 只含部分标量,
    // 不含外键字段(updatedBy)与 version —— 用错类型 TS 会直接拒绝。
    const data: Prisma.NodeUncheckedUpdateManyInput = {
      updatedBy: operator.id,
      version: { increment: 1 },
    };
    if (input.title !== undefined) data.title = input.title.trim();
    if (input.status !== undefined) data.status = input.status;

    const claimed = await this.prisma.node.updateMany({
      where: { id: nodeId, version: input.version, deletedAt: null },
      data,
    });
    if (claimed.count === 0) throw AppError.versionConflict();

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.update',
      targetType: 'node',
      targetId: nodeId,
      detail: { title: input.title ?? null, status: input.status ?? null },
    });

    // 改标题会让"继承来的权限"的展示变化(祖先标题出现在推导链里),所以失效缓存。
    // 只是展示层 —— 判定本身不受标题影响,但换一个 30 秒的准确度很便宜。
    if (input.title !== undefined) await this.permissions.invalidateByNode(nodeId);

    return this.detail(operator, nodeId);
  }

  /**
   * 移动节点(拖拽排序与改父级是同一个操作)。
   *
   * 全程在一个 Serializable 事务里:
   *  1. 用乐观锁认领这次修改;
   *  2. **一条 UPDATE 递归重建整棵子树的路径与深度**;
   *  3. 自身换父与落位。
   */
  async move(operator: Actor, nodeId: string, input: MoveNodeInput): Promise<NodeDetail> {
    const { row } = await this.permissions.requireEdit(operator, nodeId);

    let newParentPath: string | null = null;

    if (input.newParentId !== null) {
      // 目标父节点也要能改 —— 否则可以把节点"搬进"一个自己无权动的分支。
      const parent = await this.pluck(input.newParentId);
      await this.permissions.requireEdit(operator, input.newParentId);

      // 防环:目标不能是自己或自己的子孙。
      // 判据用物化路径前缀 —— 比递归查子孙便宜得多,而且不可能漏。
      const isSelfOrDescendant =
        input.newParentId === nodeId ||
        parent.materializedPath.startsWith(subtreePrefix(row.materializedPath));
      if (isSelfOrDescendant) {
        throw AppError.validation('不能把节点移动到它自己或它的子节点下');
      }

      newParentPath = parent.materializedPath;
    }

    const newPath = newParentPath === null ? pathOfRoot(nodeId) : pathOfChild(newParentPath, nodeId);
    const newDepth = newParentPath === null ? 0 : idsOfPath(newParentPath).length;
    const oldPrefix = row.materializedPath;

    await runSerializable(this.prisma, async (tx) => {
      const claimed = await tx.node.updateMany({
        where: { id: nodeId, version: input.version, deletedAt: null },
        data: { version: { increment: 1 }, updatedBy: operator.id },
      });
      if (claimed.count === 0) throw AppError.versionConflict();

      // ⚠️ 这一步是整棵树的核心。从「旧前缀长度 + 1」处截掉前缀,再接上新前缀:
      // 自身(整串 = 旧前缀)截出来是空串,恰好得到 newPath;
      // 子孙则保留下半段相对路径。一条语句覆盖整棵子树。
      //
      // ⚠️⚠️ 必须用 `substr(x, $n::int)`,**不能**写 `substring(x from $n)`:
      // PostgreSQL 里 `substring(string from pattern)` 是 POSIX 正则那一种,
      // 当参数类型是 unknown(Prisma 的 $executeRaw 就是这么发的)时会被解析到
      // 正则分支,结果**静默返回 NULL** —— 实测踩过。若 materialized_path 可空,
      // 这会把整棵子树的路径悄悄清掉,而不报任何错。
      await tx.$executeRaw`
        UPDATE nodes
           SET materialized_path = ${newPath}::text || substr(materialized_path, ${oldPrefix.length + 1}::int),
               depth = depth + ${newDepth - row.depth}::int,
               updated_at = now()
         WHERE id = ${nodeId}::uuid
            OR materialized_path LIKE ${subtreePrefix(oldPrefix)}::text || '%'
      `;

      const position =
        input.newPosition === undefined
          ? await nextPositionIn(tx, input.newParentId)
          : await makeRoomAt(tx, input.newParentId, nodeId, input.newPosition);

      await tx.node.update({
        where: { id: nodeId },
        data: { parentId: input.newParentId, position },
      });
    });

    // 路径变了 → 整棵子树的祖先链都变了 → 权限缓存必须失效。
    await this.permissions.invalidateByNode(nodeId);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.move',
      targetType: 'node',
      targetId: nodeId,
      detail: { newParentId: input.newParentId },
    });

    return this.detail(operator, nodeId);
  }

  /**
   * 软删除:**整棵子树**一起进回收站(§8.2)。
   *
   * 子树跟着标记是必须的 —— 否则父节点没了、子节点还挂在树上,
   * 而它们的路径里还写着已删除的父 id。
   */
  async remove(operator: Actor, nodeId: string): Promise<{ removedCount: number }> {
    const { row } = await this.permissions.requireEdit(operator, nodeId);

    // 整批用**同一个时间戳**。注意 `deletedAt: null` 这个条件不能少:
    // 子树里可能已经有早先单独删掉的节点,再盖一次新时间戳既没有意义,
    // 也会让返回的 removedCount 虚高(界面上会显示成「删了 N 个」而实际只动了 1 个)。
    const at = new Date();
    const result = await this.prisma.node.updateMany({
      where: {
        deletedAt: null,
        OR: [
          { id: nodeId },
          { materializedPath: { startsWith: subtreePrefix(row.materializedPath) } },
        ],
      },
      data: { deletedAt: at, deletedBy: operator.id },
    });

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.delete',
      targetType: 'node',
      targetId: nodeId,
      detail: { removedCount: result.count },
    });

    return { removedCount: result.count };
  }

  /**
   * 从回收站恢复(含整棵子树)。
   *
   * 若原父节点也还在回收站里(或已被彻底删除),就**挂回顶层** ——
   * 否则恢复出来的节点会挂在一个看不见的父节点下。
   */
  async restore(operator: Actor, nodeId: string): Promise<NodeDetail> {
    // 回收站里的节点在判定上也算"不存在",所以这里显式放行已删除的行,
    // 否则恢复接口永远拿不到节点(表现为"恢复一个已删除的节点报 404")。
    const { row } = await this.permissions.chainOf(nodeId, { allowDeleted: true });
    await this.permissions.requireEdit(operator, nodeId);

    if (row.deletedAt === null) throw AppError.validation('该节点不在回收站里');

    const full = await this.pluck(nodeId, { allowDeleted: true });

    let mustReparent = false;
    if (full.parentId !== null) {
      const parent = await this.prisma.node.findUnique({
        where: { id: full.parentId },
        select: { deletedAt: true },
      });
      mustReparent = parent === null || parent.deletedAt !== null;
    }

    const oldPrefix = full.materializedPath;
    const newPath = pathOfRoot(nodeId);
    const subtree = subtreePrefix(oldPrefix);

    await runSerializable(this.prisma, async (tx) => {
      // 先清 deleted_at:这一步用**旧路径前缀**圈整棵子树。
      // 顺序很讲究 —— 后面的路径重建会用新前缀,届时旧前缀就找不到了。
      await tx.node.updateMany({
        where: { OR: [{ id: nodeId }, { materializedPath: { startsWith: subtree } }] },
        data: { deletedAt: null, deletedBy: null },
      });

      if (mustReparent) {
        // parent_id = NULL 只对本棵子树的根做(子孙保持各自父子关系)。
        // substr(x, $n::int) 的写法同上:不能用 substring(x from $n)。
        await tx.$executeRaw`
          UPDATE nodes
             SET materialized_path = ${newPath}::text || substr(materialized_path, ${oldPrefix.length + 1}::int),
                 depth = depth + ${-full.depth}::int,
                 parent_id = CASE WHEN id = ${nodeId}::uuid THEN NULL ELSE parent_id END,
                 updated_at = now()
           WHERE id = ${nodeId}::uuid
              OR materialized_path LIKE ${subtree}::text || '%'
        `;
      }
    });

    await this.permissions.invalidateByNode(nodeId);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.restore',
      targetType: 'node',
      targetId: nodeId,
      detail: { reparentedToRoot: mustReparent },
    });

    return this.detail(operator, nodeId);
  }

  /**
   * 彻底删除(不可逆)。**只允许作用于回收站里的节点** ——
   * 强制「先软删除、再彻底删除」两步,避免手一滑把活着的节点永久删掉。
   *
   * ⚠️ 门槛是 `canManage`(祖先链所有者)而**不是** `canEdit` ——
   * 被授权者能改能软删(可恢复),但不能彻底销毁(§5.4)。
   */
  async purge(operator: Actor, nodeId: string): Promise<void> {
    const { row } = await this.permissions.chainOf(nodeId, { allowDeleted: true });
    await this.permissions.requireManage(operator, nodeId);

    if (row.deletedAt === null) {
      throw AppError.validation('只能彻底删除回收站里的节点,请先移入回收站');
    }

    const subtree = subtreePrefix(row.materializedPath);

    await runSerializable(this.prisma, async (tx) => {
      // ⚠️ nodes.parent_id 是 `onDelete: Restrict`(§4.3),而 DELETE 不支持 ORDER BY,
      // 所以不能一条语句删整棵子树:外键检查是**即时**触发的,
      // 处理到父行时子行还在,直接撞约束。
      // 按深度从大到小逐层删 —— 叶子先走。循环上限纯属防御。
      for (let guard = 0; guard < CHAIN_GUARD; guard += 1) {
        const remaining = await tx.node.findMany({
          where: { OR: [{ id: nodeId }, { materializedPath: { startsWith: subtree } }] },
          select: { id: true, depth: true },
        });
        if (remaining.length === 0) return;

        // 自己找最深的一层,**不依赖数据库的返回顺序**。
        // 靠 orderBy 的话,排序一旦失效(或被后人删掉)这段逻辑会静默退化成
        // 「每轮删一层但顺序不可控」—— 表现就是偶尔撞外键,极难复现。
        let maxDepth = -1;
        for (const item of remaining) {
          if (item.depth > maxDepth) maxDepth = item.depth;
        }

        const ids = remaining.filter((item) => item.depth === maxDepth).map((item) => item.id);
        await tx.node.deleteMany({ where: { id: { in: ids } } });
      }
      throw AppError.validation('节点层级异常,彻底删除已中止');
    });

    await this.permissions.invalidateByNode(nodeId);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.purge',
      targetType: 'node',
      targetId: nodeId,
      detail: { title: row.title },
    });
  }

  // ==================================================================
  // 私有
  // ==================================================================

  /** 取一个节点。已删除的默认视同不存在。 */
  private async pluck(
    nodeId: string,
    options: { allowDeleted?: boolean } = {},
  ): Promise<DetailRow> {
    const row = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: DETAIL_SELECT,
    });
    if (row === null) throw AppError.notFound();
    if (row.deletedAt !== null && options.allowDeleted !== true) throw AppError.notFound();
    return row;
  }

  /** 由物化路径还原面包屑(从根到自身)。祖先不是递归查出来的,是路径字符串切出来的。 */
  private async breadcrumbOf(path: string): Promise<NodeBreadcrumb[]> {
    const ids = idsOfPath(path);
    if (ids.length === 0) return [];

    const rows = await this.prisma.node.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true },
    });
    const titles = new Map(rows.map((row) => [row.id, row.title]));

    return ids
      .filter((id) => titles.has(id))
      .map((id) => ({ id, title: titles.get(id) ?? '' }));
  }

  /** 批量取未解决评论数。直接查表,不走 CommentService(避免模块环)。 */
  private async openCommentCounts(nodeIds: readonly string[]): Promise<Map<string, number>> {
    if (nodeIds.length === 0) return new Map();

    const rows = await this.prisma.comment.groupBy({
      by: ['nodeId'],
      where: { nodeId: { in: [...nodeIds] }, status: 'open' },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.nodeId, row._count._all]));
  }

  private async userBrief(userId: string): Promise<UserBrief> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_BRIEF_SELECT,
    });
    return row ?? { id: userId, name: '未知', employeeNo: '', status: 'departed' };
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

// ==================================================================
// 模块级纯函数 / 小工具(不依赖 this,便于单测)
// ==================================================================

function defaultTitleFor(kind: NodeKind): string {
  return kind === 'space' ? '未命名空间' : '未命名页面';
}

/** 同级末尾的下一个位置。 */
async function nextPositionIn(
  tx: Prisma.TransactionClient,
  parentId: string | null,
): Promise<number> {
  const last = await tx.node.findFirst({
    where: { parentId, deletedAt: null },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return (last?.position ?? -1) + 1;
}

/**
 * 在指定位置插入:把该位置及之后的兄弟整体后移一位,返回目标位置。
 *
 * `excludeId` 是必要的 —— 被移动的节点此刻**还挂在原位置**,
 * 不排除的话它会被自己挤走一位,拖拽结果偏一格。
 */
async function makeRoomAt(
  tx: Prisma.TransactionClient,
  parentId: string | null,
  excludeId: string,
  position: number,
): Promise<number> {
  await tx.node.updateMany({
    where: { parentId, deletedAt: null, position: { gte: position }, id: { not: excludeId } },
    data: { position: { increment: 1 } },
  });
  return position;
}
