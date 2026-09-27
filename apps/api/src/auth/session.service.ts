import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';

/** 签发结果。`token` 只在这一刻存在,之后库里只有它的哈希。 */
export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** 解析成功后的会话信息。 */
export interface ResolvedSession {
  sessionId: string;
  userId: string;
}

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/** lastSeenAt 的写回节流:避免每个已认证请求都产生一次写库。 */
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

/**
 * 会话服务 —— 见 DESIGN.md §6.1.1。
 *
 * 两条安全要点:
 *  1. **库里只存 token 的 SHA-256,不存 token 本身。** 即使数据库被读走,
 *     也无法据此伪造登录态。token 是 256 位随机值,无需加盐抗彩虹表。
 *  2. **会话落 PG 而不是 Redis。** §3.2 明确 Redis「不作为唯一数据源」;
 *     会话若只放 Redis,一次 flush 就全员掉线,且认证会变成 Redis 硬依赖。
 */
/** 过期会话的清理周期。默认 6 小时 —— 过期行早几小时晚几小时被删掉,没人会察觉。 */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private readonly ttlMs: number;
  /** 清理定时器。null 表示还没装上(或已卸下)。 */
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const hours = config.get<number>('sessionTtlHours') ?? 24 * 30;
    this.ttlMs = hours * 60 * 60 * 1000;
  }

  /**
   * 装上过期会话的清理定时器。
   *
   * ⚠️ 刻意不引 @nestjs/schedule:为一个六小时跑一次、每次一条 DELETE 的任务
   * 拉一个依赖不值当。两点要注意:
   *   1. `unref()` —— 定时器不能把事件循环钉住,否则容器收到 SIGTERM 后
   *      要等超时才退出,表现为"部署时要多等一截"。
   *   2. `onModuleDestroy` 里清掉 —— 测试与优雅关闭都不该留着它跑。
   */
  onModuleInit(): void {
    this.purgeTimer = setInterval(() => {
      void this.purgeExpired()
        .then((count) => {
          if (count > 0) this.logger.log(`已清理 ${String(count)} 条过期会话`);
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `清理过期会话失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.purgeTimer !== null) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  /** token → 入库主键。用 sha256 十六进制(64 字符,对应 schema 里的 CHAR(64))。 */
  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(userId: string, meta: SessionMeta = {}): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.prisma.session.create({
      data: {
        id: SessionService.hashToken(token),
        userId,
        expiresAt,
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
      },
    });

    return { token, expiresAt };
  }

  /**
   * 校验 token。返回 null 表示无效或已过期 —— 调用方一律当作「未登录」处理,
   * 不区分「不存在」与「已过期」,避免给出额外信息。
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const sessionId = SessionService.hashToken(token);

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true, expiresAt: true, lastSeenAt: true },
    });

    if (session === null) return null;

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) {
      // 顺手清掉过期行;失败也无所谓(可能被并发删除),不影响判定结果。
      await this.prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
      return null;
    }

    if (now - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.prisma.session
        .update({ where: { id: sessionId }, data: { lastSeenAt: new Date(now) } })
        .catch(() => undefined);
    }

    return { sessionId, userId: session.userId };
  }

  async revoke(token: string): Promise<void> {
    await this.prisma.session
      .delete({ where: { id: SessionService.hashToken(token) } })
      .catch(() => undefined);
  }

  /**
   * 吊销某人的全部会话。停用账号、修改密码、移出空间时调用 ——
   * 这正是选「服务端会话」而不是 JWT 换来的能力(§6.1.1 理由一)。
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.session.deleteMany({ where: { userId } });
    return result.count;
  }

  /**
   * 清理过期会话。
   *
   * ⚠️ 它曾经是**死代码**:注释写着"供将来的定时任务调用",而"将来"一直没来,
   * 于是 sessions 表只增不减、过期行永远留着。现在由上面那个定时器驱动。
   */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return result.count;
  }
}
