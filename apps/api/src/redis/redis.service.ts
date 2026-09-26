import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/** DI 令牌。用令牌注入,方便测试时替换成内存实现。 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Redis 连接。
 *
 * 阶段一用途:权限判定缓存(§5.5)。阶段二再加在线态。
 *
 * lazyConnect + enableOfflineQueue=false 是刻意的:
 * Redis 挂掉时**立刻失败**而不是把命令排进队列等它回来。
 * 否则一次 Redis 抖动会让所有请求挂满超时,把小故障放大成雪崩。
 * 权限判定缓存本来就是「读不到就回源数据库」的可降级依赖(§3.2:不作为唯一数据源)。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const url = config.get<string>('redisUrl') ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // 连接失败时不要无限重连刷日志,由健康检查统一暴露
      retryStrategy: (times: number) => (times > 5 ? null : Math.min(times * 200, 2000)),
    });

    // ioredis 在无人监听 'error' 时会抛未捕获异常直接杀进程 —— 必须挂一个。
    this.client.on('error', () => {
      // 刻意静默:/health/ready 会如实报告 down,这里刷屏没有额外价值。
    });
  }

  /** 健康检查用:主动连接并 ping。失败即抛,由调用方转成组件状态。 */
  async ping(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
