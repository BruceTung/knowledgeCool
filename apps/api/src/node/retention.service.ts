/**
 * 回收站保留策略 —— DESIGN.md §11.3「回收站未做自动清理」的落地(v2.4)。
 *
 * ## 为什么需要它
 *
 * 在 v2.4 之前,回收站里的节点**永远留着**:没有任何机制会让它们消失。
 * 结果有两件事说不清 —— 磁盘会慢慢被吃掉,而且"回收站里三年前那条还能恢复吗"
 * 没有答案(事实是能)。
 *
 * ## 三条刻意的设计
 *
 * 1. **只要子树根**。判断标准与 `NodeService.trash()` 完全一致:自己没有
 *    "活着的"父节点。逐个节点算过期时间会让一棵子树被拆着删 ——
 *    先删子再删父,中途恢复就得到一个残缺的树。
 *
 * 2. **`retentionDays <= 0` = 关闭**。自动删除用户数据这件事必须能被
 *    明确关掉,而不是靠"把天数设得很大"来绕。运维关掉它之后,
 *    手动清理接口仍然可用(仍然是超管显式动作)。
 *
 * 3. **删除逻辑复用 `NodeService.purgeSubtree`**。这条路径与手工「彻底删除」
 *    必须是同一份实现 —— 见那边的注释:按深度从叶子往根删这件事,
 *    写两份就一定会有一份忘掉外键约束那个坑。
 */

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TrashPolicy, TrashPurgeResult } from '@knowledgecool/shared';

import { recordAudit } from '../audit/record.js';
import { rootIdOfPath, subtreePrefix } from '../common/node-path.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../permission/permission.service.js';
import { NodeService } from './node.service.js';

/**
 * 启动后多久跑第一次清理。
 *
 * 刻意**不**在启动瞬间跑:那一刻数据库可能刚做完迁移、容器刚冷启动,
 * 而清理并不急(它清的是几天前的数据)。给 30 秒错开。
 */
const FIRST_RUN_DELAY_MS = 30_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 判定一个已删节点的删除时刻是否**已经过了保留期**。
 *
 * 单独抽成纯函数是为了能被单测直接覆盖 —— 这个判断的方向搞反(把 `<` 写成 `>`)
 * 的后果是"把所有回收站内容立刻清空",而且它不会有任何报错。
 */
export function isPastRetention(
  deletedAt: Date | null,
  now: Date,
  retentionDays: number,
): boolean {
  if (retentionDays <= 0) return false;
  if (deletedAt === null) return false;
  // 边界是**闭区间**:刚好满 30 天算过期。
  return now.getTime() - deletedAt.getTime() >= retentionDays * MS_PER_DAY;
}

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private interval: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  /** 防重入 —— 上一次还没跑完就不再启一次 */
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly nodes: NodeService,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit(): void {
    const days = this.retentionDays();
    const hours = this.config.get<number>('trashPurgeIntervalHours') ?? 6;

    if (days <= 0 || hours <= 0) {
      this.logger.log(
        `回收站自动清理**已关闭**(TRASH_RETENTION_DAYS=${String(days)}, 间隔=${String(hours)}h)。` +
          '超管仍可手动触发 POST /admin/maintenance/trash-purge',
      );
      return;
    }

    this.firstRun = setTimeout(() => {
      void this.tick();
    }, FIRST_RUN_DELAY_MS);
    this.firstRun.unref();

    this.interval = setInterval(() => {
      void this.tick();
    }, hours * 60 * 60 * 1000);
    this.interval.unref();

    this.logger.log(`回收站自动清理已启用:保留 ${String(days)} 天,每 ${String(hours)} 小时扫一次`);
  }

  onModuleDestroy(): void {
    if (this.firstRun !== null) clearTimeout(this.firstRun);
    if (this.interval !== null) clearInterval(this.interval);
  }

  /**
   * 当前生效的保留策略(只读)。
   *
   * 存在的理由是**不要前后端各写一份天数**:界面上的文案要是硬编码的
   * "超过 30 天会被清理",而运维把环境变量改成 90,那句提示就成了假话 ——
   * 而"东西什么时候会自己消失"正是用户最需要被告知准确的一件事。
   */
  policy(): TrashPolicy {
    return {
      retentionDays: this.retentionDays(),
      purgeIntervalHours: this.config.get<number>('trashPurgeIntervalHours') ?? 6,
    };
  }

  /**
   * 执行一次清理。定时任务与超管的手动接口都走这里。
   *
   * `dryRun` 只列不删 —— 界面与运维脚本靠它回答"这一跑会清掉什么"。
   * 一个会删数据的任务**必须**能先空跑一次,否则没人敢开它。
   */
  async run(options: { dryRun?: boolean } = {}): Promise<TrashPurgeResult> {
    const retentionDays = this.retentionDays();
    if (retentionDays <= 0) {
      return { retentionDays, roots: [], purgedNodes: 0 };
    }

    const candidates = await this.expiredRoots(retentionDays);

    const roots: TrashPurgeResult['roots'] = [];
    for (const node of candidates) {
      roots.push({
        id: node.id,
        title: node.title,
        deletedAt: (node.deletedAt ?? new Date()).toISOString(),
        subtreeSize: await this.subtreeSizeOf(node.id, node.materializedPath),
      });
    }

    if (options.dryRun === true) {
      return { retentionDays, roots, purgedNodes: 0 };
    }

    let purgedNodes = 0;
    for (const node of candidates) {
      try {
        const removed = await this.nodes.purgeSubtree({
          id: node.id,
          materializedPath: node.materializedPath,
        });
        purgedNodes += removed;

        // 与手工 purge 同理:节点已经不在库里,要用**删除前**的路径算部门 id
        await this.permissions.invalidate(rootIdOfPath(node.materializedPath));

        await recordAudit(this.prisma, {
          // actor 为 null:这不是谁干的,是系统按保留策略做的
          actorId: null,
          action: 'node.purge.auto',
          targetType: 'node',
          targetId: node.id,
          detail: {
            title: node.title,
            subtreeSize: removed,
            retentionDays,
            deletedAt: node.deletedAt?.toISOString() ?? null,
          },
        });
      } catch (error: unknown) {
        // 一棵树删失败不能带倒整轮清理 —— 剩下的照删。
        // 但必须**记下来**:静默跳过会让"回收站怎么还是满的"永远查不出来。
        this.logger.error(
          `自动清理失败:${node.title}(${node.id})— ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (purgedNodes > 0) {
      this.logger.log(
        `回收站自动清理:清理 ${String(candidates.length)} 棵子树,共 ${String(purgedNodes)} 个节点`,
      );
    }

    return { retentionDays, roots, purgedNodes };
  }

  /**
   * 已过保留期的**子树根**。
   *
   * 判据与 `NodeService.trash()` 一致:父节点不存在、或父节点还活着。
   * 两者**必须一致** —— 否则会出现"回收站界面上看不到它,但它被清理了",
   * 管理员会认为东西凭空消失。
   */
  private async expiredRoots(retentionDays: number): Promise<
    { id: string; title: string; materializedPath: string; deletedAt: Date | null }[]
  > {
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);

    return this.prisma.node.findMany({
      where: {
        deletedAt: { not: null, lt: cutoff },
        OR: [{ parentId: null }, { parent: { deletedAt: null } }],
      },
      select: { id: true, title: true, materializedPath: true, deletedAt: true },
      // 老的最先清 —— 万一中途出错,先处理的也是更该走的那些
      orderBy: { deletedAt: 'asc' },
    });
  }

  private async subtreeSizeOf(id: string, materializedPath: string): Promise<number> {
    return this.prisma.node.count({
      where: {
        OR: [{ id }, { materializedPath: { startsWith: subtreePrefix(materializedPath) } }],
      },
    });
  }

  private retentionDays(): number {
    return this.config.get<number>('trashRetentionDays') ?? 30;
  }

  /** 定时那一跳。异常必须在这里被吞掉 —— 抛出去会让 interval 静默停摆。 */
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.run();
    } catch (error: unknown) {
      this.logger.error(
        `回收站自动清理整轮失败:${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }
}
