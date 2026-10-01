import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ComponentStatus, HealthResponse, ReadinessResponse } from '@knowledgecool/shared';

import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

/** 探针里回显的依赖错误信息要截断 —— 它是给运维看的线索,不是堆栈倾倒场。 */
const MAX_ERROR_LENGTH = 160;

interface ComponentResult {
  status: ComponentStatus;
  error?: string;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/**
 * 健康检查。
 *
 * 拆成两个探针是刻意的,不是形式主义:
 *   - **liveness(/health)**:只回答「进程还在正常跑吗」。**不碰任何外部依赖** ——
 *     否则数据库抖一下,编排器会把健康的进程反复重启,把一次小故障放大成雪崩。
 *   - **readiness(/health/ready)**:回答「现在能提供服务吗」。逐个检查依赖并如实上报。
 *
 * DESIGN.md §6.3 把两个健康接口分开了:`/api/v1/health` 返回 200 就是 liveness(它不碰外部依赖)。
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  liveness(): HealthResponse {
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: this.config.get<string>('appVersion') ?? '0.0.0',
    };
  }

  async readiness(): Promise<{ httpStatus: number; body: ReadinessResponse }> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const components = { database, redis };

    const allUp = Object.values(components).every((component) => component.status === 'up');
    const body: ReadinessResponse = {
      status: allUp ? 'ok' : 'degraded',
      components,
    };

    if (!allUp) {
      // 只在降级时记日志,避免每 10 秒一次的探针刷满日志。
      const down = Object.entries(components)
        .filter(([, component]) => component.status === 'down')
        .map(([name, component]) => `${name}: ${component.error ?? 'unknown'}`);
      this.logger.warn(`就绪检查未通过 —— ${down.join(' | ')}`);
    }

    return { httpStatus: allUp ? 200 : 503, body };
  }

  private async checkDatabase(): Promise<ComponentResult> {
    try {
      await this.prisma.ping();
      return { status: 'up' };
    } catch (error: unknown) {
      return { status: 'down', error: describeError(error) };
    }
  }

  private async checkRedis(): Promise<ComponentResult> {
    try {
      await this.redis.ping();
      return { status: 'up' };
    } catch (error: unknown) {
      return { status: 'down', error: describeError(error) };
    }
  }
}
