/**
 * 登录限流与账号锁定 —— §6.1.2 的加固。
 *
 * ## 为什么必须有它
 *
 * 在它之前,POST /auth/login **没有任何次数限制**。而本系统的初始密码是
 * 统一内置的 123456、工号可枚举 —— 于是「猜到工号 → 试 123456 →
 * 拿一次性凭证设一个新密码」是一条**不限次数**的账号接管路径。
 * 这是阶段一最实际的缺口,不是理论风险。
 *
 * ## 两道闸,各挡一种攻击
 *
 *   1. **按账号锁**:同一工号连续失败 loginMaxAttempts 次 → 锁 loginLockMinutes 分钟。
 *      挡的是「盯着一个账号猛试」。失败计数自身也带同样的过期时间,
 *      所以零星打错几次不会累积到某天突然被锁。
 *   2. **按来源 IP 限制失败总数**:挡的是「每个账号只试一次」的横向撒网
 *      (拿 123456 去撞几千个工号)。**只数失败,成功不计** ——
 *      否则早上集体登录会把整个办公室的出口 IP 顶掉。
 *
 *      ⚠️ 内网常常所有人共用一个出口 IP,所以这个阈值刻意给得宽
 *      (LOGIN_IP_MAX_FAILURES,默认 100/15 分钟),而且可以设 0 关闭。
 *      真正的硬控制是上面那条按账号锁。
 *
 * ## 三个刻意的设计决定
 *
 * 1. **计数键用工号,不管这个工号在库里存不存在。**
 *    如果只对真实账号计数,那"你被锁了"这个响应本身就成了账号枚举器 ——
 *    而 §6.1 专门用假 bcrypt + 时序对齐把枚举堵掉了(见 AuthService 类注释第 1、2 条)。
 *    这里的口径必须和它一致:不存在的工号一样会被锁,响应一模一样。
 * 2. **Redis 不可用时降级放行,并且只警告一次。**
 *    与权限缓存同一个立场(§3.2:Redis 不作为唯一数据源)。
 *    要清楚这意味着**Redis 挂掉的期间锁定是失效的** —— 这是明确接受的降级,
 *    不是疏漏。compose 里 Redis 与 api 同生共死,且 /health/ready 会如实报 down。
 * 3. **锁定状态放 Redis 而不是 users 表。**
 *    加两列要动 migration、要处理"值班管理员手动解锁"的入口,而锁定本来就是
 *    **分钟级**的临时状态 —— 用带 TTL 的键天然自愈,不需要清理任务,
 *    也不需要"解锁"接口。
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import { RedisService } from '../redis/redis.service.js';

/** 一次限流判定的结果。 */
export interface ThrottleVerdict {
  locked: boolean;
  /** 还要等多少秒才能再试(仅在 locked 为真时有意义)。 */
  retryAfterSeconds: number;
}

export const UNLOCKED: ThrottleVerdict = Object.freeze({ locked: false, retryAfterSeconds: 0 });

/** 键前缀。与权限缓存共用 kc: 前缀,便于运维一眼认出是本系统的键。 */
const KEY_PREFIX = 'kc:login';

/**
 * 工号归一化成计数键。
 *
 * 登录成功与否只取决于**逐字节相同**的工号(库里的 employee_no 区分大小写),
 * 所以大小写变体本来就登不进去;这里仍然统一大小写与空白,
 * 是为了让"故意用大小写变体刷次数"落在同一个桶里,而不是散成许多个。
 */
export function normalizeEmployeeNo(employeeNo: string): string {
  return employeeNo.trim().toLowerCase();
}

export function userFailureKey(employeeNo: string): string {
  return KEY_PREFIX + ':fail:u:' + normalizeEmployeeNo(employeeNo);
}

export function userLockKey(employeeNo: string): string {
  return KEY_PREFIX + ':lock:u:' + normalizeEmployeeNo(employeeNo);
}

export function ipFailureKey(ip: string): string {
  return KEY_PREFIX + ':fail:ip:' + ip;
}

export function ipLockKey(ip: string): string {
  return KEY_PREFIX + ':lock:ip:' + ip;
}

/** 达到阈值了吗?抽成纯函数是为了让边界(第 4 次 vs 第 5 次)能被单测钉住。 */
export function reachedThreshold(failures: number, maxAttempts: number): boolean {
  return maxAttempts > 0 && failures >= maxAttempts;
}

/** 人类可读的等待时长。只给分与秒两档 —— 再细反而让人以为很精确。 */
export function formatWait(seconds: number): string {
  if (seconds <= 60) return String(seconds) + ' 秒';
  return String(Math.ceil(seconds / 60)) + ' 分钟';
}

/**
 * 锁定时的统一文案。
 *
 * **按账号锁与按 IP 限速共用同一句** —— 两种原因的文案若能分辨,
 * 就等于又交出一个区分维度。文案里不透露是哪种,也不透露账号是否存在。
 */
export function lockMessage(seconds: number): string {
  return (
    '登录尝试次数过多,已临时锁定,请 ' +
    formatWait(seconds) +
    ' 后再试。若忘记密码,请联系管理员重置。'
  );
}

@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);
  /** 降级警告只打一次,避免每次登录都刷日志。 */
  private degraded = false;

  private readonly maxAttempts: number;
  private readonly lockSeconds: number;
  private readonly ipMaxFailures: number;
  private readonly ipWindowSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.maxAttempts = config.get<number>('loginMaxAttempts') ?? 5;
    this.lockSeconds = (config.get<number>('loginLockMinutes') ?? 15) * 60;
    this.ipMaxFailures = config.get<number>('loginIpMaxFailures') ?? 100;
    this.ipWindowSeconds = (config.get<number>('loginIpWindowMinutes') ?? 15) * 60;
  }

  /** 现在能不能试?锁定期间**不校验密码** —— 否则锁定形同虚设。 */
  async check(employeeNo: string, ip: string | null): Promise<ThrottleVerdict> {
    if (this.disabled()) return UNLOCKED;

    const accountWait = await this.remainingSeconds(userLockKey(employeeNo));
    const ipWait = ip === null ? 0 : await this.remainingSeconds(ipLockKey(ip));
    const wait = Math.max(accountWait, ipWait);

    return wait > 0 ? { locked: true, retryAfterSeconds: wait } : UNLOCKED;
  }

  /**
   * 记一次失败。返回是否**因此**进入锁定(调用方据此写审计)。
   *
   * 已经锁着时直接返回现状,不再累加 —— 锁定期间继续累加没有意义,
   * 只会让攻击者把锁越拖越长,连带把真正的用户也一起拖住。
   */
  async recordFailure(employeeNo: string, ip: string | null): Promise<ThrottleVerdict> {
    if (this.disabled()) return UNLOCKED;

    const current = await this.check(employeeNo, ip);
    if (current.locked) return current;

    const accountLocked = await this.bump(
      userFailureKey(employeeNo),
      userLockKey(employeeNo),
      this.maxAttempts,
      this.lockSeconds,
    );
    const ipLocked =
      ip === null
        ? false
        : await this.bump(ipFailureKey(ip), ipLockKey(ip), this.ipMaxFailures, this.ipWindowSeconds);

    if (!accountLocked && !ipLocked) return UNLOCKED;
    return { locked: true, retryAfterSeconds: this.lockSeconds };
  }

  /**
   * 登录成功,清掉这个账号的失败计数与锁。
   *
   * **刻意不清 IP 计数**:一个出口 IP 是多人共用的,某个人登录成功
   * 不代表那个 IP 上的撒网行为已经停止。
   */
  async recordSuccess(employeeNo: string): Promise<void> {
    await this.run('clear', (client) =>
      client.del(userFailureKey(employeeNo), userLockKey(employeeNo)),
    );
  }

  private disabled(): boolean {
    return this.maxAttempts <= 0 && this.ipMaxFailures <= 0;
  }

  /** 计数 +1;达到阈值就落一个带 TTL 的锁键。 */
  private async bump(
    failureKey: string,
    lockKey: string,
    threshold: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const failures = await this.run('incr', async (client) => {
      const value = await client.incr(failureKey);
      // 只有第一次才设过期:每次失败都续期的话,持续攻击会让计数永不过期。
      if (value === 1) await client.expire(failureKey, windowSeconds);
      return value;
    });

    if (failures === null || !reachedThreshold(failures, threshold)) return false;

    await this.run('lock', (client) => client.set(lockKey, '1', 'EX', windowSeconds));
    return true;
  }

  /** 锁键还剩多少秒。键不存在 / 没有 TTL 都返回 0。 */
  private async remainingSeconds(key: string): Promise<number> {
    const pttl = await this.run('pttl', (client) => client.pttl(key));
    if (pttl === null || pttl <= 0) return 0;
    return Math.ceil(pttl / 1000);
  }

  /**
   * 所有 Redis 访问的唯一入口:统一处理「连不上」与「命令失败」。
   *
   * enableOfflineQueue=false 意味着 Redis 没连上时命令会**立刻抛**
   * (见 RedisService 的注释),所以这里要先按需建连 —— 与 RedisService.ping 一致。
   */
  private async run<T>(label: string, fn: (client: Redis) => Promise<T>): Promise<T | null> {
    try {
      if (this.redis.client.status === 'wait') {
        await this.redis.client.connect();
      }
      const result = await fn(this.redis.client);
      this.degraded = false;
      return result;
    } catch (error: unknown) {
      if (!this.degraded) {
        this.degraded = true;
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn('Redis 不可用,登录限流暂时失效(' + label + '): ' + reason);
      }
      return null;
    }
  }
}
