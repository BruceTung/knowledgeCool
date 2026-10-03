import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  type Actor,
  type BulkMoveNodesInput,
  type BulkMoveResult,
  BULK_MOVE_MAX,
  type CreateNodeInput,
  type MoveNodeInput,
  type NodeBreadcrumb,
  type NodeDetail,
  type NodeKind,
  type NodeTreeResponse,
  type UpdateNodeInput,
  toNodeStatus,
  readableNodeIds,
  toNodeVisibility,
} from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { hasPrismaCode, runSerializable } from '../common/db/serializable.js';
import { AppError } from '../common/errors/app-error.js';
import {
  idsOfPath,
  pathOfChild,
  pathOfRoot,
  rootIdOfPath,
  subtreePrefix,
} from '../common/node-path.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService, type AccessContext } from '../permission/permission.service.js';

/**
 * 节点服务 —— DESIGN.md §6.2 的节点接口 + §8.1/§8.2 的两个关键流程。
 *
 * ⚠️ **v2.0 起空间与页面合并为一棵树**(`page` → `node`)。
 * 因此与旧版 PageService 的三处结构性差别:
 *   1. 不再有 `spaceId` —— 树是全公司一棵,一级节点就是部门
 *   2. 鉴权全部改走 `PermissionService` 的**关系判定**(不再有角色等级)
 *   3. `tree()` 一次性返回**整棵树**(按可见性过滤后),并附带"我哪些能改/能管"
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
  status: true,
  // ⚠️ version 必须进树 —— 前端拖拽要拿它做乐观锁。
  // 少了这一列,前端就得为每次拖拽先单独拉一次详情,多一轮往返而且
  // 两次读之间数据可能已经变了(拖拽落到错误位置)。
  version: true,
  ownerId: true,
  createdBy: true,
  // v2.12:树的保密过滤要在内存里判可见性,所以这一列必须进查询
  visibility: true,
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
  visibility: true,
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

/**
 * 判权只要这三个字段。刻意单独定义一个窄类型:
 * 取"祖先"时它不在返回集里(只用于内存向上走),用 `TREE_SELECT` 的完整形状
 * 会逼着查询多取一堆用不上的列。
 */
type ChainLookup = {
  id: string;
  parentId: string | null;
  ownerId: string;
  depth: number;
  visibility: string;
  /** 受限节点对创建者可读(v2.15),所以判定要这个字段 */
  createdBy: string;
};

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
   * 整棵树。给 `rootId` 时只返回**那棵子树**。
   *
   * **会做可见性过滤**(v2.12)。默认 public 的节点人人可见(§5.3 规则一),
   * 但 `restricted` 的节点及其子树只对授权的人可见 —— 被摘掉的节点
   * **根本不会出现在响应里**,所以它下面的 public 子节点也一并看不到。
   * 判定本身在 shared 的 `readableNodeIds`(纯函数,见下面的说明)。
   *
   * 另外会算出「我哪些能改、我哪些能管」交给前端**隐藏按钮**。
   * ⚠️ 那只是体验,服务端仍是唯一裁判。
   *
   * 权限标记是**在内存里算的**:逐节点调 `permissions.access()` 会退化成
   * N+1 查询,而树的规模是几千个节点。
   *
   * ## `rootId`(v2.4)
   *
   * 全员开放读 + 一棵大树,公司到几千人时"一次性返回全量"会很大。
   * 接口形状先留出来(§11.3 明确要求「不要做成只能返回全部」)。
   *
   * ⚠️ 只返回子树时,**祖先**仍然要查出来参与判权 —— 它们不在响应里,
   * 但"我能不能改这个节点"取决于祖先链上的所有者。少了这一步,
   * 子树里的每个节点都会算成"我改不了"。
   */
  async tree(operator: Actor, rootId?: string): Promise<NodeTreeResponse> {
    let scopePath: string | null = null;
    if (rootId !== undefined) {
      /*
        ⚠️⚠️ v4.9:**先判读**再决定怎么回答。

        原来只查路径、查不到就 404 —— 于是这条接口成了一个
        **受限节点的存在性预言机**:
          · 节点**不存在**      → 404
          · 节点**存在但我读不到** → 200 + `nodes: []`

        两种回答形状不同,任何登录用户拿一个 id 试一次就能区分
        "这个 id 存在吗"。而"它存在"本身就是要保密的信息
        (§5.6:一处不漏地收口,否则一致性本身就是安全性质)。
        `members` / `memberCandidates` / `readers` 都已经补过这道闸,
        只有建树这条漏着。

        补上之后,两种情况对调用方**完全同形**(都是 404)——
        `requireRead` 正是这么设计的:读不到就当作不存在。
      */
      await this.permissions.requireRead(operator, rootId);
      const root = await this.pluck(rootId);
      scopePath = root.materializedPath;
    }

    const rows = await this.prisma.node.findMany({
      where:
        scopePath === null
          ? {}
          : {
              OR: [{ id: rootId }, { materializedPath: { startsWith: subtreePrefix(scopePath) } }],
            },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: TREE_SELECT,
    });

    if (rows.length === 0) {
      return { nodes: [], editableNodeIds: [], manageableNodeIds: [] };
    }

    const byId = new Map<string, ChainLookup>();
    for (const row of rows) byId.set(row.id, row);

    // 指定 root 时补上祖先链 —— 只用于判权,不进响应
    if (scopePath !== null) {
      const missing = idsOfPath(scopePath).filter((id) => !byId.has(id));
      if (missing.length > 0) {
        const ancestors = await this.prisma.node.findMany({
          where: { id: { in: missing } },
          select: {
            id: true,
            parentId: true,
            ownerId: true,
            depth: true,
            visibility: true,
            createdBy: true,
          },
        });
        for (const ancestor of ancestors) byId.set(ancestor.id, ancestor);
      }
    }

    // ---- v2.13:保密过滤 ----
    //
    // ⚠️ 判定本身**不在这里**,而是 shared 里的 `readableNodeIds` ——
    // 这段逻辑「错了不会报错」,只表现为「某一层的标题被不该看见的人看见了」,
    // 所以它被刻意下沉成零 IO 的纯函数:判定能单独推理,不靠"跑一遍看看"。
    // 写在这里的话要连着 Prisma 一起 mock 才验得到,而那种测试没人会去写。
    //
    // 这里只负责**取数**:把判定需要的字段(祖先链 + 受限节点的两张名单)凑齐。
    // 注意 byId 里必须包含判定范围的全部祖先 —— rootId 场景下祖先不在 rows 里,
    // 但取祖先那一步已经把它们补进了 byId。
    const restrictedIds = [...byId.values()]
      .filter((node) => node.visibility === 'restricted')
      .map((node) => node.id);
    const accessLists = await this.permissions.accessListsFor(restrictedIds);

    const readable = readableNodeIds(
      operator.id,
      // createdBy 必须一起传:受限节点对创建者永远可读(与 canManageReaders 对齐)。
      // 少传的话 TypeScript 会拦(它是必填) —— 这是刻意的,字段漏传的后果是
      // "创建者在树上看不见自己的节点",而那种不一致只在界面上看得出来。
      [...byId.values()].map((node) => ({
        id: node.id,
        parentId: node.parentId,
        ownerId: node.ownerId,
        createdBy: node.createdBy,
        visibility: node.visibility,
      })),
      accessLists,
    );

    const visibleRows = rows.filter((row) => readable.has(row.id));

    const nodeIds = visibleRows.map((row) => row.id);
    const [grants, commentCounts, briefs] = await Promise.all([
      this.prisma.nodeGrant.findMany({
        where: { nodeId: { in: nodeIds } },
        select: { nodeId: true, userId: true },
      }),
      this.commentCounts(nodeIds),
      this.userBriefMap(rows.flatMap((row) => [row.ownerId, row.createdBy])),
    ]);

    const grantsByNode = new Map<string, Set<string>>();
    for (const grant of grants) {
      const bucket = grantsByNode.get(grant.nodeId) ?? new Set<string>();
      bucket.add(grant.userId);
      grantsByNode.set(grant.nodeId, bucket);
    }

    const editableNodeIds: string[] = [];
    const manageableNodeIds: string[] = [];

    for (const row of visibleRows) {
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
      nodes: visibleRows.map((row) => ({
        id: row.id,
        parentId: row.parentId,
        kind: row.kind as NodeKind,
        title: row.title,
        position: row.position,
        depth: row.depth,
        status: toNodeStatus(row.status),
        version: row.version,
        // 受限节点**只可能出现在"我读得到"的位置** —— 读不到的那些已经在
        // 上面被摘掉了,所以这里如实回传即可(前端据此画锁形图标)。
        visibility: toNodeVisibility(row.visibility),
        ownerId: row.ownerId,
        ownerName: briefs.get(row.ownerId)?.name ?? '未知',
        commentCount: commentCounts.get(row.id) ?? 0,
      })),
      editableNodeIds,
      manageableNodeIds,
    };
  }

  /** 单节点详情,含从根到自身的面包屑与"我能否改/管"。 */
  async detail(operator: Actor, nodeId: string): Promise<NodeDetail> {
    const row = await this.pluck(nodeId);
    const access = await this.permissions.access(operator, nodeId);

    // ⚠️ 读不到 → 404,不是 403(v2.12 保密)。403 等于确认"这里有个你看不见
    // 的东西",而保密的意义正在于不确认它的存在。内部调用(改名/移动)都已经
    // 通过了 requireEdit,那时 canRead 必然为真,所以这一句只挡直接的读请求。
    if (!access.canRead) throw AppError.notFound();

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
      visibility: toNodeVisibility(row.visibility),
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

    const id = randomUUID();
    const title = input.title?.trim() ?? '';

    /*
      ⚠️⚠️ 父路径必须在事务**内**读(与 `move` 同一条原则,见那边的详细说明)。

      原来这里是在事务外 `pluck` 父节点、拿它的 `materializedPath` 当快照,
      再在事务里用这个快照算新节点的路径。若另一个请求在这两步之间把父节点
      移到了别处,新节点的 `parent_id` 与 `materialized_path` 就会**互相矛盾**:
      父子关系是对的,路径却指向一个父节点已经不在的位置。

      这与 v4.7 修掉的「Excel 导入物化路径写错」是**同一类缺陷**,
      后果也一样:权限靠路径前缀找祖先链,链一断,`canEdit`/`canManage`
      就对这棵子树判错(既可能失权,也可能**失去受限继承而变成人人可读**),
      而且不会自愈。`pnpm db:verify` 现在会检查"路径 ↔ 父子一致性",
      但那只是事后发现 —— 这里要从源头不让它发生。

      为什么 Serializable 救不了:PostgreSQL 的谓词锁只覆盖事务内
      **实际访问过**的行。原实现的事务从未读过父节点,SSI 看不见这条依赖,
      本事务又只写自己的新行 —— 两边都能提交。
    */
    const row = await this.prisma.$transaction(async (tx) => {
      let parentPath: string | null = null;
      let depth = 0;

      if (input.parentId !== null) {
        const fresh = await tx.node.findUnique({
          where: { id: input.parentId },
          select: { materializedPath: true, depth: true },
        });
        // 父节点在事务内消失了(并发删除):继续写会造出孤儿路径
        if (fresh === null) throw AppError.notFound();
        parentPath = fresh.materializedPath;
        depth = fresh.depth + 1;
      }

      const materializedPath = parentPath === null ? pathOfRoot(id) : pathOfChild(parentPath, id);
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
      where: { id: nodeId, version: input.version },
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
    } else {
      /*
        ⚠️ 移到**一级**(`newParentId: null` / 省略该字段)原来**完全没有任何校验**。

        `MoveNodeDto.newParentId` 默认就是 `null`,所以"不传这个字段"等于静默
        把节点提升成部门。它绕过了两件事:

        1. **建一级节点只有管理员能做**(`requireCreateUnder(operator, null)`,
           §5.3)。普通成员 —— 甚至只是**被授权者**(有 `canEdit` 就够)——
           都能借此把节点搬到顶层,等于自己给自己造了一个部门。
        2. **更严重的是它会摘掉保密继承。** 受限部门的子孙之所以读不到,是因为
           祖先链上有那个受限节点(§5.6:整棵子树继承,后代无法放开)。
           移到一级之后链上不再有受限祖先,它就**对所有人可读**(检索也会搜到)——
           一个 `canEdit` 的人可以借此把受限内容公开出去。

        所以这一支必须与"新建一级节点"共用同一道闸。
      */
      await this.permissions.requireCreateUnder(operator, null);
    }

    await runSerializable(this.prisma, async (tx) => {
      /*
        ⚠️⚠️ v2.16:**目标父节点的路径必须在事务内重读。**

        上面那次 `pluck`/`requireEdit` 都是在事务**外**做的,拿到的
        `newParentPath` 只是个快照。若另一个请求在这两步之间把目标父节点
        移到了别处,而这次执行又用**过期的路径**去重写子树 ——
        被移动的那棵子树的 `materialized_path` 会指向一个**父节点已经不在的位置**。

        后果不是报错,而是**永久性的静默损坏**:`PermissionService.chainOf`
        靠 `prefixPathsOf(自身路径)` 反查祖先链,路径一旦对不上真实父子关系,
        链就断了 —— `canEdit`/`canManage` 从此对那棵子树判错(既可能失权,
        也可能越权),而且不会自愈。

        为什么依赖 Serializable 隔离级别救不了它:PostgreSQL 的谓词锁
        **只覆盖事务内实际访问过的数据**。这里的事务从未读过目标父节点那一行,
        于是 SSI 看不见"这次读"与"另一个事务的移动"之间的依赖;
        而本事务又只写自己那棵子树、不写父节点,连写冲突都不会有 —— 两边都能提交。

        读进来之后就重新做一次防环判定(目标可能已经**变成**了自己的子孙),
        再做路径重写。这是本文件里唯一一处"读必须在事务内"的地方;
        `deleteSubtree` 每轮重查剩余行,遵循的是同一条原则。
      */
      /*
        ⚠️ v5.45(P0 修复):防环判定也必须用**事务内**的自身路径。
        原来这里用的是 `row.materializedPath` —— 事务外那份,
        它可能已经不是当前路径了。而防环判错的后果比路径写坏更直接:
        把节点搬进自己的子孙下面,树成环。
      */
      const selfNow = await tx.node.findUnique({
        where: { id: nodeId },
        select: { materializedPath: true },
      });
      if (selfNow === null) throw AppError.notFound();

      let effectiveNewParentPath = newParentPath;
      if (input.newParentId !== null) {
        const fresh = await tx.node.findUnique({
          where: { id: input.newParentId },
          select: { materializedPath: true },
        });
        // 目标在事务内消失了:并发把它删了。此时继续写会造出孤儿路径。
        if (fresh === null) throw AppError.notFound();
        if (
          input.newParentId === nodeId ||
          fresh.materializedPath.startsWith(subtreePrefix(selfNow.materializedPath))
        ) {
          throw AppError.validation('不能把节点移动到它自己或它的子节点下');
        }
        effectiveNewParentPath = fresh.materializedPath;
      }

      await applyMoveTo(tx, {
        nodeId,
        newParentId: input.newParentId,
        newParentPath: effectiveNewParentPath,
        actorId: operator.id,
        version: input.version,
        position: input.newPosition,
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
   * **批量移动**(v2.14)。
   *
   * ## 为什么只做"移动",不做"批量删除"
   *
   * 移动是**可逆**的(再移回去就行),而删除 v2.12 起不可恢复。
   * 批量删除的误操作代价和它的价值完全不成比例 —— 真要清理一整块旧内容,
   * 删那个组本身就够了。所以这里**刻意只开移动**。
   *
   * ## 两条为了"结果可预测"而加的限制
   *
   * 1. **不允许批量里出现互为祖先的节点**。
   *    选了 A 又选它里面的 B 时,结果取决于执行顺序:先移 A 会把 B 一起带走,
   *    再移 B 又把它拽出来 —— 两者最终都在目标下,但用户看到的中间态与
   *    "我明明只选了两个,怎么动了三个"这类疑问都会出现。直接拒绝更清楚。
   * 2. **逐节点校验权限**,不做任何"选了一批就一起放行"的捷径。
   *    审批式的批量放行是越权的常见来源。
   *
   * ## 原子性
   *
   * 全部校验通过之后,**一个事务里全做或全不做**。
   * 不做"部分成功 + 失败清单":那会留下一个用户没预期过的中间状态,
   * 而他需要自己去核对哪几个动了 —— 对"整理目录"这种操作来说是纯粹的负担。
   */
  async bulkMove(operator: Actor, input: BulkMoveNodesInput): Promise<BulkMoveResult> {
    const ids = [...new Set(input.nodeIds)];
    if (ids.length === 0) throw AppError.validation('请先选择要移动的节点');
    if (ids.length > BULK_MOVE_MAX) {
      throw AppError.validation(`一次最多移动 ${String(BULK_MOVE_MAX)} 个节点`);
    }

    // ---- 校验阶段:全部通过才开始写 ----
    const rows = new Map<string, AccessContext['row']>();
    for (const id of ids) {
      const { row } = await this.permissions.requireEdit(operator, id);
      rows.set(id, row);
    }

    const target = input.newParentId;
    await this.permissions.requireEdit(operator, target);
    const parentRow = await this.pluck(target);

    // 不能把某个节点移到它自己或它的子孙下
    for (const [id, row] of rows) {
      const isSelfOrDescendant =
        target === id || parentRow.materializedPath.startsWith(subtreePrefix(row.materializedPath));
      if (isSelfOrDescendant) {
        throw AppError.validation(`「${row.title}」不能移动到它自己或它的子节点下`);
      }
    }

    // 批量里不能互为祖先 —— 见上面第 1 条限制
    for (const [id, row] of rows) {
      for (const [otherId, otherRow] of rows) {
        if (id === otherId) continue;
        if (otherRow.materializedPath.startsWith(subtreePrefix(row.materializedPath))) {
          throw AppError.validation(
            `「${otherRow.title}」在「${row.title}」里面,请只选最外层的那几个`,
          );
        }
      }
    }

    // ---- 执行阶段:一个事务,全做或全不做 ----
    //
    // ⚠️ 这里**不留** parentRow.materializedPath 的快照:目标路径必须在事务内
    // 重读(见下面那段说明)。校验阶段用过的 parentRow 只用于防环判定,
    // 而那次判定也会在事务内按新路径重做一遍。
    await runSerializable(this.prisma, async (tx) => {
      /*
        ⚠️ v2.16:目标路径在事务内**重读**。理由与 `move` 里那段完全一样 ——
        `newParentPath` 是校验阶段(事务外)的快照,并发把目标移走之后
        再拿它重写子树,会造出一棵指向"父节点已不在的位置"的子树;
        而权限判定靠物化路径取祖先链,链断之后是**静默判权错误**。
        (Serializable 救不了它:本事务从未读过目标那一行,谓词锁无从建立。)
      */
      const freshTarget = await tx.node.findUnique({
        where: { id: target },
        select: { materializedPath: true },
      });
      if (freshTarget === null) throw AppError.notFound();

      for (const id of ids) {
        const stale = rows.get(id);
        if (stale === undefined) continue;
        /*
          ⚠️ v5.45(P0 修复):与 `move()` 同一条理由 —— 自身路径必须在
          **事务内**重读。原来用的是事务外那份 `rows`,防环判错就会把
          节点搬进自己的子孙下,树成环。
        */
        const selfNow = await tx.node.findUnique({
          where: { id },
          select: { materializedPath: true, title: true },
        });
        if (selfNow === null) continue;
        // 防环也要按**新**路径重判一次:目标可能已经被移进了某个选中节点的子树
        if (
          target === id ||
          freshTarget.materializedPath.startsWith(subtreePrefix(selfNow.materializedPath))
        ) {
          throw AppError.validation(`「${selfNow.title}」不能移动到它自己或它的子节点下`);
        }
        await applyMoveTo(tx, {
          nodeId: id,
          newParentId: target,
          newParentPath: freshTarget.materializedPath,
          actorId: operator.id,
          // 批量移动一律**追加到末尾**。让每个节点都能指定位置的话,
          // 用户要在脑子里模拟一次完整的排序,而那是拖拽该做的事。
          position: undefined,
        });
      }
    });

    // 路径变了 → 每个被移动节点(及其子树)的祖先链都变了
    for (const id of ids) await this.permissions.invalidateByNode(id);

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.bulkMove',
      targetType: 'node',
      targetId: target,
      detail: {
        count: ids.length,
        titles: [...rows.values()].map((row) => row.title),
        nodeId: target,
      },
    });

    return { moved: ids.length, newParentId: target };
  }

  /**
   * 删除节点 —— **整棵子树一起物理删除,不可恢复**(v2.12)。
   *
   * ⚠️ 门槛是 `canManage`(该节点或祖先链上的所有者),**不是** `canEdit`。
   * v2.12 之前这里是软删除(进回收站、可恢复),所以"能改"就够了;现在删除
   * 不可逆,门槛必须与破坏性相称 —— 被授权者仍然能改,但不能销毁。
   * (旧模型里 `purge` 走的就是 `canManage`,这条边界一直都在,
   *  只是现在它成了唯一的删除路径。)
   */
  async remove(operator: Actor, nodeId: string): Promise<{ removedCount: number }> {
    /*
      ⚠️ v4.9:用 `requireManageForWrite`(**不判读**)。

      原来走 `requireManage`,而它内部先断 `canRead`。删除从不读内容,
      可是受限节点上 `canManage` 可以宽于 `canRead`(我是所有者,但链上更靠上的
      受限祖先没放行我)—— 那时**删除真的执行了(行没了、审计也写进去了),
      接口却回 404**。调用方以为失败,实际已生效,还会去重试。
      与 `replaceReaders` / `addMember` 是同一个坑,详见
      `PermissionService.requireManageForWrite`。

      安全没有放宽:这里断的仍是 `canManage`(该节点或祖先链上的所有者)。
    */
    const { row } = await this.permissions.requireManageForWrite(operator, nodeId, '删除节点');

    const removedCount = await this.deleteSubtree({
      id: row.id,
      materializedPath: row.materializedPath,
    });

    // ⚠️ 用**删除前**记下的路径算部门 id。节点此刻已经不在库里了,
    // `invalidateByNode` 会查不到路径然后静默跳过失效 —— 缓存会一直残留到 TTL。
    await this.permissions.invalidate(rootIdOfPath(row.materializedPath));

    await recordAudit(this.prisma, {
      actorId: operator.id,
      action: 'node.delete',
      targetType: 'node',
      targetId: nodeId,
      detail: { title: row.title, removedCount },
    });

    return { removedCount };
  }

  /**
   * 物理删除一棵子树,返回删掉的节点总数。
   *
   * ⚠️ **不含任何权限判定** —— 判权由调用方负责(`remove` 走 `canManage`)。
   * 抽出来的理由是这类"按深度从叶子往根删"的逻辑只能有一份:写两份的话,
   * 总有一天其中一份会漏掉下面那条外键约束的坑,而那个坑的表现是
   * "偶尔删不掉",极难复现。
   */
  async deleteSubtree(input: { id: string; materializedPath: string }): Promise<number> {
    const subtree = subtreePrefix(input.materializedPath);

    return runSerializable(this.prisma, async (tx) => {
      let removed = 0;

      // ⚠️ nodes.parent_id 是 `onDelete: Restrict`(§4.3),而 DELETE 不支持 ORDER BY,
      // 所以不能一条语句删整棵子树:外键检查是**即时**触发的,
      // 处理到父行时子行还在,直接撞约束。
      // 按深度从大到小逐层删 —— 叶子先走。循环上限纯属防御。
      for (let guard = 0; guard < CHAIN_GUARD; guard += 1) {
        const remaining = await tx.node.findMany({
          where: { OR: [{ id: input.id }, { materializedPath: { startsWith: subtree } }] },
          select: { id: true, depth: true },
        });
        if (remaining.length === 0) return removed;

        // 自己找最深的一层,**不依赖数据库的返回顺序**。
        // 靠 orderBy 的话,排序一旦失效(或被后人删掉)这段逻辑会静默退化成
        // 「每轮删一层但顺序不可控」—— 表现就是偶尔撞外键,极难复现。
        let maxDepth = -1;
        for (const item of remaining) {
          if (item.depth > maxDepth) maxDepth = item.depth;
        }

        const ids = remaining.filter((item) => item.depth === maxDepth).map((item) => item.id);
        /*
          ⚠️ v2.16:把外键冲突翻译成一句人话。

          正常情况下这一层不可能还有子节点(depth 最大的层必然无子),
          所以 `onDelete: Restrict` 不该被触发。真触发只有一种原因:
          **`depth` 与实际父子关系对不上**(数据损坏 —— 例如历史遗留的行、
          或某次路径重写没把 depth 一起改对)。此时删父行会撞约束。

          原来撞上去就是裸的 Postgres 错误 → 全局过滤器兜成 **500**
          「服务器内部错误」,而下面那句"节点层级异常"**永远走不到** ——
          它描述的是真正的原因,却对不上用户实际看到的错误。
          现在先接住 FK 错误并说明它,再抛那句兜底。
        (不损坏数据:整个事务回滚,一个节点都不会被删掉。)
        */
        try {
          await tx.node.deleteMany({ where: { id: { in: ids } } });
        } catch (error: unknown) {
          if (hasPrismaCode(error, 'P2003') || hasPrismaCode(error, 'P2014')) {
            throw AppError.validation(
              '这棵子树的数据不一致(有节点的层级与实际父子关系对不上),删除已中止,未删除任何内容。请联系管理员用 verify-db 检查。',
            );
          }
          throw error;
        }
        removed += ids.length;
      }
      throw AppError.validation('节点层级异常,彻底删除已中止');
    });
  }

  // ==================================================================
  // 私有
  // ==================================================================

  /** 取一个节点。取不到就 404。 */
  private async pluck(nodeId: string): Promise<DetailRow> {
    const row = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: DETAIL_SELECT,
    });
    if (row === null) throw AppError.notFound();
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

    return ids.filter((id) => titles.has(id)).map((id) => ({ id, title: titles.get(id) ?? '' }));
  }

  /**
   * 批量取**评论总数**。直接查表,不走 CommentService(避免模块环)。
   *
   * 数的是"有几条评论",不是"有几个待解决问题" —— 这个系统里没有"问题"
   * 这个概念(2026-09-27 用户纠正)。原来这里带 `status: 'open'` 过滤。
   */
  private async commentCounts(nodeIds: readonly string[]): Promise<Map<string, number>> {
    if (nodeIds.length === 0) return new Map();

    const rows = await this.prisma.comment.groupBy({
      by: ['nodeId'],
      where: { nodeId: { in: [...nodeIds] } },
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
/**
 * 一次移动的**全部写入**,跑在调用方给的 tx 上。
 *
 * ⚠️ 抽出来是因为 `move` 与 `bulkMove` 必须走**同一份**路径重写逻辑。
 * 抄一份出来的代价:某天有人只修了其中一份,另一份就开始悄悄出错 ——
 * 而物化路径写错的表现是「某棵子树的祖先链错了」,那会连带把权限判定也带偏,
 * 且不报任何错(§12:凡是写数据的逻辑,只允许存在一份)。
 *
 * 三件事:乐观锁、子树路径重写、位置。顺序不能换 ——
 * 位置要在路径改好之后再算(否则算的是旧父节点下的兄弟)。
 */
async function applyMoveTo(
  tx: Prisma.TransactionClient,
  params: {
    nodeId: string;
    newParentId: string | null;
    newParentPath: string | null;
    actorId: string;
    /** 省略 = 不做乐观锁(CAS)。批量移动不逐个校验版本 —— 见 bulkMove 的说明。 */
    version?: number;
    /** 省略 = 追加到目标末尾。 */
    position?: number;
  },
): Promise<void> {
  const { nodeId, newParentId, newParentPath, actorId } = params;

  /*
    ⚠️⚠️ v5.45(P0 修复):被移动节点**自己的** `materialized_path` / `depth`
    在这里、**事务内**重读,不用调用方在事务外取的那份。
    =
    原来 `row` 是参数,而它来自 `move()` 开头的 `requireEdit` —— **事务外**。
    整棵子树的路径重写以 `row.materializedPath` 为基准:

        UPDATE nodes SET materialized_path = newPath || substr(materialized_path, oldPrefix.length + 1) ...
       WHERE id = ? OR materialized_path LIKE oldPrefix || '%'

    那个 `substr` 的偏移量是从 `oldPrefix.length` 算的。所以只要
    **这个值在事务开始前已经过期**,偏移就整体错位。

    2026-10-04 在真实库上算过:`/uuid1/uuid2` 长度 74,若它的祖先
    被移到另一个父节点下,同一节点的真实路径变成 111 字符,
    此时 `substr(真实路径, 75)` 返回**空串** —— 于是整棵子孙的路径
    被截成只剩新前缀,全部塌缩到父节点那一层。
    `WHERE` 里的 `LIKE oldPrefix || '%'` 同样匹配不到(它们已在新位置),
    于是子孙**原地不动**。结果:`parent_id` 与 `materialized_path` 彻底脱钩,
    祖先链断裂 —— 而 `canRead` 是逐环检查的,链上少了那个 `restricted`
    祖先就**直接放行**,变成静默越权。它也不会自愈。

    为什么 `runSerializable` 救不了:谓词锁只覆盖事务内**实际读过**的行。
    这里用的是事务外的快照,SSI 看不见"这次读"与别人的写之间的依赖。

    ⚠️ 所以这不只是"补一次重读",而是**把 row 从签名里删掉** ——
    让"忘了在事务内重读"这件事在类型上不可能发生。
    下一个调用方想传一个事务外的行进来,编译就过不去。
  */
  const self = await tx.node.findUnique({
    where: { id: nodeId },
    select: { materializedPath: true, depth: true },
  });
  // 事务内消失了:并发把它删了。此时继续写会造出孤儿路径。
  if (self === null) throw AppError.notFound();
  const row = self;

  if (params.version !== undefined) {
    const claimed = await tx.node.updateMany({
      where: { id: nodeId, version: params.version },
      data: { version: { increment: 1 }, updatedBy: actorId },
    });
    if (claimed.count === 0) throw AppError.versionConflict();
  } else {
    /*
      ⚠️ v5.45(P0 修复):没有 CAS 时也要**递增** version。
      =
      原来这里只写 `updatedBy`,`version` 原地不动 —— 后果不是"少一次校验",
      而是**这次移动对其他客户端完全不可见**:它们手里的 `version` 依然是旧值,
      于是下一次改名/改可见性会**拿着过期的版本号却仍然成功**,
      乐观锁在跨端协作下等于没有。

      而且它还是上面那个数据损坏缺陷(P0-2)的一条触发路径:
      别的操作靠 `version` 抢占,而批量移动对版本号毫无影响,撞不上。

      → 递增**不需要**比对,成本为零,却能让所有并发客户端正确察觉冲突。
    */
    await tx.node.update({
      where: { id: nodeId },
      data: { version: { increment: 1 }, updatedBy: actorId },
    });
  }

  const newPath = newParentPath === null ? pathOfRoot(nodeId) : pathOfChild(newParentPath, nodeId);
  const newDepth = newParentPath === null ? 0 : idsOfPath(newParentPath).length;
  const oldPrefix = row.materializedPath;

  // ⚠️ 这一步是整棵树的核心。从「旧前缀长度 + 1」处截掉前缀,再接上新前缀:
  // 自身(整串 = 旧前缀)截出来是空串,恰好得到 newPath;
  // 子孙则保留下半段相对路径。一条语句覆盖整棵子树。
  //
  // ⚠️⚠️ 必须用 substr(x, $n::int),**不能**写 substring(x from $n):
  // PostgreSQL 里 substring(string from pattern) 是 POSIX 正则那一种,
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
    params.position === undefined
      ? await nextPositionIn(tx, newParentId)
      : await makeRoomAt(tx, newParentId, nodeId, params.position);

  await tx.node.update({ where: { id: nodeId }, data: { parentId: newParentId, position } });
}

async function nextPositionIn(
  tx: Prisma.TransactionClient,
  parentId: string | null,
): Promise<number> {
  const last = await tx.node.findFirst({
    where: { parentId },
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
    where: { parentId, position: { gte: position }, id: { not: excludeId } },
    data: { position: { increment: 1 } },
  });
  return position;
}
