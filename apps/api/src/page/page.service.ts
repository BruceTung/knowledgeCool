import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  isPageStatus,
  type Actor,
  type CreatePageInput,
  type MovePageInput,
  type PageBreadcrumb,
  type PageDetail,
  type PageNode,
  type PageStatus,
  type PageTreeResponse,
  type TrashItem,
  type UpdatePageInput,
} from '@knowledgecool/shared';

import { runSerializable } from '../common/db/serializable.js';
import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SpaceService } from '../space/space.service.js';

const PAGE_SELECT = {
  id: true,
  spaceId: true,
  parentId: true,
  title: true,
  position: true,
  materializedPath: true,
  depth: true,
  status: true,
  version: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PageSelect;

type PageRow = Prisma.PageGetPayload<{ select: typeof PAGE_SELECT }>;

/** 树查询只取渲染需要的字段 —— 不带路径,它不该出现在响应里。 */
const TREE_SELECT = {
  id: true,
  parentId: true,
  title: true,
  position: true,
  depth: true,
  status: true,
  version: true,
} satisfies Prisma.PageSelect;

type TreeRow = Prisma.PageGetPayload<{ select: typeof TREE_SELECT }>;

/**
 * 页面树服务(DESIGN.md §6.2 的页面接口 + §8.1/§8.2 的两个关键流程)。
 *
 * ## 物化路径
 *
 * 每个页面存一条 `materialized_path`,形如 `/根id/父id/自身id`(根是 `/自身id`)。
 * 它换来两件事:
 *  1. **查整棵子树**从递归 CTE 变成一次前缀扫描(`LIKE '/p1/%'`,吃 `pages_path_idx`);
 *  2. **移动子树**从「递归改每一行」变成一条 UPDATE(见 `move`)。
 *
 * ## 这一节最容易做错的地方
 *
 * `move` 必须**递归重建整棵子树**的路径与深度。只改自己那一条的话,
 * 所有子孙的路径会指向旧位置 —— 权限判定(§5.2 沿路径回溯)会跟着错,
 * 而且**当下不会报任何错**,直到某天有人发现"某篇文档莫名其妙没有权限"。
 */
@Injectable()
export class PageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpaceService,
  ) {}

  // ==================================================================
  // 读
  // ==================================================================

  /**
   * 整棵页面树(不含回收站)。
   *
   * 一次性返回整棵而不是懒加载:前端的展开/折叠/拖拽因此全是本地计算。
   * 阶段一的树规模(几百到几千节点)下,这点响应体远比每次展开都发请求划算。
   */
  async tree(operator: Actor, spaceId: string): Promise<PageTreeResponse> {
    const access = await this.spaces.requireCapability(operator, spaceId, 'page.view');

    const rows = await this.prisma.page.findMany({
      where: { spaceId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: TREE_SELECT,
    });

    return { spaceId, role: access.role, nodes: buildTree(rows) };
  }

  /** 单页详情,含从根到自身的面包屑。 */
  async detail(operator: Actor, pageId: string): Promise<PageDetail> {
    const page = await this.requireLivePage(pageId);
    await this.spaces.requireCapability(operator, page.spaceId, 'page.view');
    return { ...toDetail(page), breadcrumb: await this.breadcrumbOf(page) };
  }

  /** 空间回收站。只列「被删子树的根」—— 恢复是整棵子树一起回来的。 */
  async trash(operator: Actor, spaceId: string): Promise<TrashItem[]> {
    await this.spaces.requireCapability(operator, spaceId, 'page.view');

    // 一次性取回该空间所有已删页面,再在内存里算子树根与子孙数。
    // 比「按每个根再发一条 count」少很多往返,而回收站的量级本来就不大。
    const rows = await this.prisma.page.findMany({
      where: { spaceId, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      select: {
        id: true,
        parentId: true,
        title: true,
        materializedPath: true,
        deletedAt: true,
        deletedBy: true,
      },
    });

    const deletedIds = new Set(rows.map((row) => row.id));
    const roots = rows.filter((row) => row.parentId === null || !deletedIds.has(row.parentId));

    return roots.map((root) => ({
      id: root.id,
      spaceId,
      title: root.title,
      deletedAt: (root.deletedAt ?? new Date()).toISOString(),
      deletedBy: root.deletedBy,
      descendantCount: rows.filter((row) =>
        row.materializedPath.startsWith(subtreePrefix(root.materializedPath)),
      ).length,
    }));
  }

  // ==================================================================
  // 写
  // ==================================================================

  /** 新建页面。父节点可空(建在空间根下)。 */
  async create(operator: Actor, input: CreatePageInput): Promise<PageDetail> {
    await this.spaces.requireCapability(operator, input.spaceId, 'page.create');

    let parentPath: string | null = null;
    let depth = 0;

    if (input.parentId !== null) {
      const parent = await this.requireLivePage(input.parentId);
      if (parent.spaceId !== input.spaceId) {
        throw AppError.validation('父页面不在这个空间里');
      }
      parentPath = parent.materializedPath;
      depth = parent.depth + 1;
    }

    // 主键在应用侧生成:路径里包含自身 id,先拿到 id 才能一次 INSERT 就把路径写对。
    // (数据库的 gen_random_uuid() 默认值只是兜底,显式给 id 会覆盖它。)
    const id = randomUUID();
    const materializedPath = parentPath === null ? pathOfRoot(id) : pathOfChild(parentPath, id);
    const title = normalizeTitle(input.title);

    const row = await this.prisma.$transaction(async (tx) => {
      const position = await nextPositionIn(tx, input.spaceId, input.parentId);
      return tx.page.create({
        data: {
          id,
          spaceId: input.spaceId,
          parentId: input.parentId,
          title,
          position,
          depth,
          materializedPath,
          createdBy: operator.id,
          updatedBy: operator.id,
        },
        select: PAGE_SELECT,
      });
    });

    return { ...toDetail(row), breadcrumb: await this.breadcrumbOf(row) };
  }

  /** 改名 / 改状态。带乐观锁。 */
  async update(operator: Actor, pageId: string, input: UpdatePageInput): Promise<PageDetail> {
    const page = await this.requireLivePage(pageId);
    await this.spaces.requireCapability(operator, page.spaceId, 'page.edit');

    // 用 Unchecked 变体:它含全部标量列(含外键 updated_by),
    // 而 PageUpdateManyMutationInput 会把这些过滤掉
    const data: Prisma.PageUncheckedUpdateManyInput = {
      updatedBy: operator.id,
      version: { increment: 1 },
    };
    if (input.title !== undefined) data.title = normalizeTitle(input.title);
    if (input.status !== undefined) data.status = input.status;

    // updateMany + where 里带 version:把「检查」与「写入」压成一条语句,
    // 避免 read-then-write 之间被别人插队(那样两边都会以为自己是赢家)
    const claimed = await this.prisma.page.updateMany({
      where: { id: pageId, version: input.version, deletedAt: null },
      data,
    });
    if (claimed.count === 0) throw AppError.versionConflict();

    return this.detail(operator, pageId);
  }

  /**
   * 移动页面(拖拽排序与改父级是同一个操作)。
   *
   * 三步走,全程在一个 Serializable 事务里:
   *  1. 用乐观锁认领这次修改;
   *  2. **一条 UPDATE 递归重建整棵子树的路径与深度**;
   *  3. 自身换父与落位。
   */
  async move(operator: Actor, pageId: string, input: MovePageInput): Promise<PageDetail> {
    const page = await this.requireLivePage(pageId);
    await this.spaces.requireCapability(operator, page.spaceId, 'page.edit');

    let newParentPath: string | null = null;

    if (input.newParentId !== null) {
      const parent = await this.requireLivePage(input.newParentId);
      if (parent.spaceId !== page.spaceId) {
        throw AppError.validation('不能跨空间移动页面');
      }

      // 防环:目标不能是自己或自己的子孙。
      // 判据用物化路径前缀 —— 比递归查子孙便宜得多,而且不可能漏。
      const isSelfOrDescendant =
        input.newParentId === pageId ||
        parent.materializedPath.startsWith(subtreePrefix(page.materializedPath));
      if (isSelfOrDescendant) {
        throw AppError.validation('不能把页面移动到它自己或它的子页面下');
      }

      newParentPath = parent.materializedPath;
    }

    const newPath = newParentPath === null ? pathOfRoot(pageId) : pathOfChild(newParentPath, pageId);
    const newDepth = newParentPath === null ? 0 : segmentsOf(newParentPath);
    const oldPrefix = page.materializedPath;

    await runSerializable(this.prisma, async (tx) => {
      const claimed = await tx.page.updateMany({
        where: { id: pageId, version: input.version, deletedAt: null },
        data: { version: { increment: 1 }, updatedBy: operator.id },
      });
      if (claimed.count === 0) throw AppError.versionConflict();

      // ⚠️ 这一步是 M3 的核心。从「旧前缀长度 + 1」处截掉前缀,再接上新前缀:
      // 自身(整串 = 旧前缀)截出来是空串,恰好得到 newPath;
      // 子孙则保留下半段相对路径。一条语句覆盖整棵子树。
      //
      // ⚠️⚠️ 必须用 `substr(x, $n::int)` 而**不能**用 `substring(x from $n)`:
      // PostgreSQL 里 `substring(string from pattern)` 是 POSIX 正则那一种,
      // 当参数类型是 unknown(Prisma 的 $executeRaw 就是这么发的)时会被解析到
      // 正则分支,结果**静默返回 NULL** —— 实测踩过。若 materialized_path 可空,
      // 这会把整棵子树的路径悄悄清掉,而不会报任何错。
      await tx.$executeRaw`
        UPDATE pages
           SET materialized_path = ${newPath}::text || substr(materialized_path, ${oldPrefix.length + 1}::int),
               depth = depth + ${newDepth - page.depth}::int,
               updated_at = now()
         WHERE space_id = ${page.spaceId}::uuid
           AND (id = ${pageId}::uuid OR materialized_path LIKE ${subtreePrefix(oldPrefix)}::text || '%')
      `;

      const position =
        input.newPosition === undefined
          ? await nextPositionIn(tx, page.spaceId, input.newParentId)
          : await makeRoomAt(tx, page.spaceId, input.newParentId, pageId, input.newPosition);

      await tx.page.update({
        where: { id: pageId },
        data: { parentId: input.newParentId, position },
      });
    });

    return this.detail(operator, pageId);
  }

  /**
   * 软删除:**整棵子树**一起进回收站(DESIGN §8.2)。
   *
   * 子页面跟着标记是必须的 —— 否则父页面没了、子页面还挂在树上,
   * 而它们的路径里还写着已删除的父 id。
   */
  async remove(operator: Actor, pageId: string): Promise<{ removedCount: number }> {
    const page = await this.requireLivePage(pageId);
    await this.spaces.requireCapability(operator, page.spaceId, 'page.delete');

    // 整批用**同一个时间戳**。注意 `deletedAt: null` 这个条件不能少:
    // 子树里可能已经有早先单独删掉的页面,再盖一次新时间戳既没有意义,
    // 也会让返回的 removedCount 虚高(界面上会显示成「删了 N 个」而实际只动了 1 个)。
    const at = new Date();
    const result = await this.prisma.page.updateMany({
      where: {
        spaceId: page.spaceId,
        deletedAt: null,
        OR: [
          { id: pageId },
          { materializedPath: { startsWith: subtreePrefix(page.materializedPath) } },
        ],
      },
      data: { deletedAt: at, deletedBy: operator.id },
    });

    return { removedCount: result.count };
  }

  /**
   * 从回收站恢复(含整棵子树)。
   *
   * 若原父节点也还在回收站里(或已被彻底删除),就**挂回空间根下** ——
   * DESIGN §8.2 的处置。否则恢复出来的页面会挂在一个看不见的父节点下。
   */
  async restore(operator: Actor, pageId: string): Promise<PageDetail> {
    const page = await this.requirePage(pageId);
    await this.spaces.requireCapability(operator, page.spaceId, 'page.restore');
    if (page.deletedAt === null) {
      throw AppError.validation('该页面不在回收站里');
    }

    let mustReparent = false;
    if (page.parentId !== null) {
      const parent = await this.prisma.page.findUnique({
        where: { id: page.parentId },
        select: { deletedAt: true },
      });
      mustReparent = parent === null || parent.deletedAt !== null;
    }

    const oldPrefix = page.materializedPath;
    const newPath = pathOfRoot(pageId);
    const subtree = subtreePrefix(oldPrefix);

    await runSerializable(this.prisma, async (tx) => {
      // 先清 deleted_at:这一步用「旧路径前缀」圈整棵子树。
      // 顺序很讲究 —— 后面的路径重建会用新前缀,届时旧前缀就找不到了。
      await tx.page.updateMany({
        where: {
          spaceId: page.spaceId,
          OR: [{ id: pageId }, { materializedPath: { startsWith: subtree } }],
        },
        data: { deletedAt: null, deletedBy: null },
      });

      if (mustReparent) {
        // parent_id = NULL 只对本棵子树的根做(子孙保持各自父子关系)。
        // 这里的 substr(x, $n::int) 写法同上:不能用 substring(x from $n)。
        await tx.$executeRaw`
          UPDATE pages
             SET materialized_path = ${newPath}::text || substr(materialized_path, ${oldPrefix.length + 1}::int),
                 depth = depth + ${-page.depth}::int,
                 parent_id = CASE WHEN id = ${pageId}::uuid THEN NULL ELSE parent_id END,
                 updated_at = now()
           WHERE space_id = ${page.spaceId}::uuid
             AND (id = ${pageId}::uuid OR materialized_path LIKE ${subtree}::text || '%')
        `;
      }
    });

    return this.detail(operator, pageId);
  }

  /**
   * 彻底删除(不可逆)。**只允许作用于回收站里的页面** ——
   * 强制「先软删除、再彻底删除」两步,避免手一滑把活页面永久删掉。
   */
  async purge(operator: Actor, pageId: string): Promise<void> {
    const page = await this.requirePage(pageId);
    await this.spaces.requireCapability(operator, page.spaceId, 'page.purge');
    if (page.deletedAt === null) {
      throw AppError.validation('只能彻底删除回收站里的页面,请先移入回收站');
    }

    const subtree = subtreePrefix(page.materializedPath);

    await runSerializable(this.prisma, async (tx) => {
      // ⚠️ pages.parent_id 是 `onDelete: Restrict`(§4.3),而 DELETE 不支持 ORDER BY,
      // 所以不能一条语句删整棵子树:外键检查是**即时**触发的,
      // 处理到父行时子行还在,直接撞约束。
      // 按深度从大到小逐层删 —— 叶子先走。循环上限纯属防御,正常深度不过十几层。
      for (let guard = 0; guard < 200; guard += 1) {
        const remaining = await tx.page.findMany({
          where: {
            spaceId: page.spaceId,
            OR: [{ id: pageId }, { materializedPath: { startsWith: subtree } }],
          },
          select: { id: true, depth: true },
        });
        if (remaining.length === 0) return;

        // 自己找最深的一层,**不依赖数据库的返回顺序**。
        // 靠 orderBy 的话,排序一旦失效(或被后人删掉)这段逻辑会静默退化成
        // 「每轮删一层但顺序不可控」—— 表现就是偶尔撞外键,极难复现。
        let maxDepth = -1;
        for (const row of remaining) {
          if (row.depth > maxDepth) maxDepth = row.depth;
        }

        const ids = remaining.filter((row) => row.depth === maxDepth).map((row) => row.id);
        await tx.page.deleteMany({ where: { id: { in: ids } } });
      }
      throw AppError.validation('页面层级异常,彻底删除已中止');
    });
  }

  // ==================================================================
  // 私有
  // ==================================================================

  /** 取一个**活着**的页面。已删除的视同不存在(§6.1:不区分「不存在」与「无权」)。 */
  private async requireLivePage(pageId: string): Promise<PageRow> {
    const page = await this.requirePage(pageId);
    if (page.deletedAt !== null) throw AppError.notFound();
    return page;
  }

  private async requirePage(pageId: string): Promise<PageRow> {
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: PAGE_SELECT,
    });
    if (page === null) throw AppError.notFound();
    return page;
  }

  /** 由物化路径还原面包屑。祖先不是递归查出来的,是路径字符串切出来的。 */
  private async breadcrumbOf(page: { materializedPath: string }): Promise<PageBreadcrumb[]> {
    const ids = ancestorIdsOf(page.materializedPath);
    if (ids.length === 0) return [];

    const rows = await this.prisma.page.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true },
    });
    const titles = new Map(rows.map((row) => [row.id, row.title]));

    return ids
      .filter((id) => titles.has(id))
      .map((id) => ({ id, title: titles.get(id) ?? '' }));
  }
}

// ==================================================================
// 模块级纯函数:路径算术与树装配(不依赖 this,便于单测)
// ==================================================================

/** 根页面路径:`/<自身id>`。 */
export function pathOfRoot(id: string): string {
  return `/${id}`;
}

/** 子页面路径:父路径 + `/<自身id>`。 */
export function pathOfChild(parentPath: string, id: string): string {
  return `${parentPath}/${id}`;
}

/** 子树前缀。查子孙一律用它做 `startsWith`,末尾那个斜杠不能少。 */
export function subtreePrefix(path: string): string {
  return `${path}/`;
}

/** 路径里的段数。根是 1 段,深度 = 段数 − 1。 */
export function segmentsOf(path: string): number {
  return path.split('/').filter((segment) => segment !== '').length;
}

/** 从路径切出祖先 id(不含自身)。 */
export function ancestorIdsOf(path: string): string[] {
  const ids = path.split('/').filter((segment) => segment !== '');
  return ids.slice(0, -1);
}

/** 标题归一:空串一律落回数据库默认值,避免出现「看不见名字」的页面。 */
function normalizeTitle(title: string | undefined): string {
  const trimmed = title?.trim() ?? '';
  return trimmed === '' ? '未命名页面' : trimmed;
}

/** 追加到同级末尾时用的位置。 */
async function nextPositionIn(
  tx: Prisma.TransactionClient,
  spaceId: string,
  parentId: string | null,
): Promise<number> {
  const last = await tx.page.findFirst({
    where: { spaceId, parentId, deletedAt: null },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return last === null ? 0 : last.position + 1;
}

/**
 * 在目标位置腾出空位:把该父节点下 position >= target 的兄弟整体后移一位。
 *
 * 排除自己 —— 否则「原地微调顺序」时自己也会被推一格,结果偏一位。
 * 删掉留下的空洞不回收(排序只看相对大小),省一次全量重排。
 */
async function makeRoomAt(
  tx: Prisma.TransactionClient,
  spaceId: string,
  parentId: string | null,
  selfId: string,
  target: number,
): Promise<number> {
  await tx.page.updateMany({
    where: {
      spaceId,
      parentId,
      deletedAt: null,
      id: { not: selfId },
      position: { gte: target },
    },
    data: { position: { increment: 1 } },
  });
  return target;
}

/**
 * 把扁平行装配成树。
 *
 * 父节点不在本次结果里的行**当根处理**而不是丢弃 —— 那通常意味着数据异常,
 * 但让它在界面上出现比让它凭空消失更容易被人发现。
 */
function buildTree(rows: readonly TreeRow[]): PageNode[] {
  const byId = new Map<string, PageNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      parentId: row.parentId,
      title: row.title,
      position: row.position,
      depth: row.depth,
      status: toPageStatus(row.status),
      version: row.version,
      children: [],
    });
  }

  const roots: PageNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id);
    if (node === undefined) continue;

    const parent = row.parentId === null ? undefined : byId.get(row.parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

function toPageStatus(value: string): PageStatus {
  return isPageStatus(value) ? value : 'published';
}

function toDetail(row: PageRow): Omit<PageDetail, 'breadcrumb'> {
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    title: row.title,
    status: toPageStatus(row.status),
    version: row.version,
    depth: row.depth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
