/**
 * 上传的**速率**限制(v4.37)。

## 为什么需要它 —— 实测出来的

上传接口原本只限制**单个文件**的大小(10MB),对**次数**没有任何限制。
真机隔离库上连传 40 次:

```
连续上传 40 次,耗时 226ms
  201 成功: 40      其它状态: []
  => 没有任何次数限制
```

40/40 全部成功、盘上落了 40 个文件,平均 **5.7ms 一次**。
按这个速率,一个已登录的账号可以在一分钟内写进**几 GB** ——
而且上传**不进审计表**(没有 `uploads` 表,`audit_logs` 里也没有上传动作),
所以事后连「谁传的」都查不到。

⚠️ **为什么不是「按人配额」而是速率限制?**
配额(比如每人 100MB)回答的是「总共能用多少」,但它**拦不住速度** ——
在配额被触顶之前,磁盘就已经被写满了。真正要防的是**短时间内的大量写入**,
所以第一道应当是速率限制。配额是另一件事(总量治理),不是这个洞的补法。

⚠️ 与 `login-throttle.ts` 一样:Redis 不可用时**降级放行**(记一条警告),
而不是把上传整体变成不可用 —— 限流是**保护**,不该成为新的单点故障。
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError } from '../common/errors/app-error.js';
import { RedisService } from '../redis/redis.service.js';

export interface UploadVerdict {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export const UPLOAD_ALLOWED: UploadVerdict = Object.freeze({
  allowed: true,
  retryAfterSeconds: 0,
});

/** 限流的键:按**用户**而不是 IP —— 上传必须已登录,用户才是稳定的维度。 */
export function uploadRateKey(userId: string): string {
  return `kc:upload:rate:${userId}`;
}

@Injectable()
export class UploadThrottleService {
  private readonly logger = new Logger(UploadThrottleService.name);
  private degraded = false;

  private readonly maxPerWindow: number;
  private readonly windowSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.maxPerWindow = config.get<number>('uploadMaxPerWindow') ?? 30;
    this.windowSeconds = (config.get<number>('uploadWindowMinutes') ?? 5) * 60;
  }

  /**
   * 记一次上传并判断是否超限。
   *
   * 用 `INCR` + 首次 `EXPIRE` 的固定窗口 —— 够用且原子:
   * 计数与过期都在 Redis 里完成,不依赖应用层的读-改-写。
   */
  async consume(userId: string): Promise<UploadVerdict> {
    if (this.disabled()) return UPLOAD_ALLOWED;

    const key = uploadRateKey(userId);
    try {
      /*
        ⚠️⚠️ v4.37:**先确保连上,再计数。**

        RedisService 用 lazyConnect:true + enableOfflineQueue:false 建连接
        (那是为了让 Redis 挂掉时**立刻失败**,不把命令排队等它回来)。
        代价是:**连接还没建立时发的第一条命令会直接抛** ——
        Stream isn't writeable and enableOfflineQueue options is false。

        实测(真机容器里复刻这两个参数):连发 4 次 incr,**4 次全部抛这个错**。

        而下面的 catch 是**故意降级放行**的,于是第一条上传会:
        **既没有计数、也没有被限流** —— 表现就是「5 次上传、计数器只有 4」。
        边界随之从 30 漂到 31,而且**只发生在进程刚起、第一条上传时**,
        属于最难查的那种偶发。

        所以这里显式 connect()(与 RedisService.ping() 同一写法):
        连上之后再计数,降级路径只留给**真的连不上**的情况。
      */
      if (this.redis.client.status === 'wait') {
        await this.redis.client.connect();
      }

      const used = await this.redis.client.incr(key);
      if (used === 1) await this.redis.client.expire(key, this.windowSeconds);
      if (used <= this.maxPerWindow) return UPLOAD_ALLOWED;

      const ttl = await this.redis.client.ttl(key);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : this.windowSeconds };
    } catch (error) {
      // 只有**真的连不上**才走这里。
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn('上传限流不可用(Redis 异常),本次放行:' + String(error));
      }
      return UPLOAD_ALLOWED;
    }
  }

  /**
   * 关掉限流的方式与 `login-throttle` **完全一致**:把配置值设成 0。
   *
   * ⚠️ 原来这里读的是一个**根本不存在的**「关闭上传限流」环境变量 ——
   * 我照着一个想象出来的先例写(登录限流其实用的是 `maxAttempts <= 0`,没有这种开关)。
   * 结果 `audit:docs` 报「代码读了它、但配置表里找不到」:
   * **文档检查器抓出了这个假引用**。现在统一成配置值,既真实、又只需要一个开关。
   */
  private disabled(): boolean {
    return this.maxPerWindow <= 0;
  }
}

/** 限流命中时的文案:说清「多久之后能再传」,不说别的。 */
export function uploadLimitMessage(seconds: number): string {
  const mins = Math.ceil(seconds / 60);
  const wait = mins <= 1 ? '不到 1 分钟' : `${String(mins)} 分钟`;
  return `上传太频繁了,请 ${wait} 后再试。`;
}

/** 与登录限流一致:用 `RATE_LIMITED`(映射到 HTTP 429)。 */
export function uploadLimitError(verdict: UploadVerdict): AppError {
  return new AppError('RATE_LIMITED', uploadLimitMessage(verdict.retryAfterSeconds), {
    retryAfterSeconds: verdict.retryAfterSeconds,
  });
}
