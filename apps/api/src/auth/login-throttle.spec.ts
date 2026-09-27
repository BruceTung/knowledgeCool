/**
 * 登录限流与账号锁定测试(v2.12)。
 *
 * 重点在**边界与降级**,而不是"能不能锁":
 *   - 第 4 次失败不该锁,第 5 次必须锁(差一次就是形同虚设或误锁)
 *   - 锁定期内继续失败**不能**把锁越拖越长(否则攻击者能把真正的用户长期关在门外)
 *   - 不存在的工号也会被锁(否则"被锁定"这个响应就是账号枚举器)
 *   - Redis 挂掉时降级放行,而不是把所有人挡在门外
 */
import { describe, expect, it, vi } from 'vitest';

import {
  LoginThrottleService,
  formatWait,
  ipFailureKey,
  ipLockKey,
  lockMessage,
  normalizeEmployeeNo,
  reachedThreshold,
  userFailureKey,
  userLockKey,
} from './login-throttle.js';

/** 够用的内存版 Redis:只实现限流用到的那几个命令,带 TTL 语义。 */
function createFakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  function alive(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  const client = {
    status: 'ready',
    connect: vi.fn(async () => undefined),
    incr: vi.fn(async (key: string) => {
      const entry = alive(key);
      const next = (entry === undefined ? 0 : Number(entry.value)) + 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      const entry = alive(key);
      if (entry === undefined) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }),
    set: vi.fn(async (key: string, value: string, _mode: string, seconds: number) => {
      store.set(key, { value: String(value), expiresAt: Date.now() + seconds * 1000 });
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    }),
    pttl: vi.fn(async (key: string) => {
      const entry = alive(key);
      if (entry === undefined) return -2;
      if (entry.expiresAt === null) return -1;
      return entry.expiresAt - Date.now();
    }),
  };

  return { client, store };
}

const CONFIG_VALUES: Record<string, number> = {
  loginMaxAttempts: 5,
  loginLockMinutes: 15,
  loginIpMaxFailures: 100,
  loginIpWindowMinutes: 15,
};

function createService(values: Record<string, number> = CONFIG_VALUES) {
  const { client, store } = createFakeRedis();
  const config = { get: vi.fn((key: string) => values[key]) };
  const service = new LoginThrottleService({ client } as never, config as never);
  return { service, client, store };
}

describe('纯函数', () => {
  it('工号归一化:去空白 + 折大小写,让变体落在同一个桶里', () => {
    expect(normalizeEmployeeNo('  KC001 ')).toBe('kc001');
    expect(normalizeEmployeeNo('kc001')).toBe(normalizeEmployeeNo('KC001'));
  });

  it('键:账号与 IP 分属不同命名空间', () => {
    expect(userFailureKey('KC001')).toBe('kc:login:fail:u:kc001');
    expect(userLockKey('KC001')).toBe('kc:login:lock:u:kc001');
    expect(ipFailureKey('10.0.0.9')).toBe('kc:login:fail:ip:10.0.0.9');
    expect(ipLockKey('10.0.0.9')).toBe('kc:login:lock:ip:10.0.0.9');
  });

  it('阈值边界:第 4 次不锁、第 5 次锁;0 表示关闭', () => {
    expect(reachedThreshold(4, 5)).toBe(false);
    expect(reachedThreshold(5, 5)).toBe(true);
    expect(reachedThreshold(6, 5)).toBe(true);
    expect(reachedThreshold(99, 0)).toBe(false);
  });

  it('等待时长文案:分与秒两档', () => {
    expect(formatWait(45)).toBe('45 秒');
    expect(formatWait(60)).toBe('60 秒');
    expect(formatWait(61)).toBe('2 分钟');
    expect(formatWait(900)).toBe('15 分钟');
  });

  it('锁定文案带上等待时长,且不透露是账号锁还是 IP 锁', () => {
    const message = lockMessage(900);
    expect(message).toContain('15 分钟');
    expect(message).toContain('联系管理员重置');
    // 不能出现"账号不存在"这类能被用来枚举的措辞
    expect(message).not.toContain('不存在');
  });
});

describe('LoginThrottleService', () => {
  it('连续失败 4 次不锁,第 5 次锁上', async () => {
    const { service } = createService();

    for (let i = 0; i < 4; i += 1) {
      const verdict = await service.recordFailure('KC001', '10.0.0.9');
      expect(verdict.locked).toBe(false);
    }

    const fifth = await service.recordFailure('KC001', '10.0.0.9');
    expect(fifth.locked).toBe(true);
    expect(fifth.retryAfterSeconds).toBe(900);
  });

  it('锁上之后 check 返回剩余秒数,且不需要先失败一次', async () => {
    const { service } = createService();
    for (let i = 0; i < 5; i += 1) await service.recordFailure('KC001', null);

    const verdict = await service.check('KC001', null);
    expect(verdict.locked).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(890);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('锁定期内继续失败**不会**把锁越拖越长(否则攻击者能把本人长期关在门外)', async () => {
    const { service } = createService();
    for (let i = 0; i < 5; i += 1) await service.recordFailure('KC001', null);

    const before = await service.check('KC001', null);
    const again = await service.recordFailure('KC001', null);
    const after = await service.check('KC001', null);

    expect(again.retryAfterSeconds).toBe(before.retryAfterSeconds);
    // 剩余时间只应该变少(时间流逝),不应该变多
    expect(after.retryAfterSeconds).toBeLessThanOrEqual(before.retryAfterSeconds);
  });

  it('计数按工号隔离:一个人被锁不影响别人', async () => {
    const { service } = createService();
    for (let i = 0; i < 5; i += 1) await service.recordFailure('KC001', null);

    expect((await service.check('KC001', null)).locked).toBe(true);
    expect((await service.check('KC002', null)).locked).toBe(false);
  });

  it('不存在的工号一样会被锁 —— 否则"被锁定"本身就是账号枚举器', async () => {
    const { service } = createService();
    for (let i = 0; i < 5; i += 1) await service.recordFailure('KC-does-not-exist', null);

    expect((await service.check('KC-does-not-exist', null)).locked).toBe(true);
  });

  it('工号大小写变体共用同一个桶', async () => {
    const { service } = createService();
    for (let i = 0; i < 5; i += 1) await service.recordFailure('kc001', null);

    expect((await service.check('KC001', null)).locked).toBe(true);
  });

  it('登录成功清掉该账号的计数与锁', async () => {
    const { service, store } = createService();
    for (let i = 0; i < 4; i += 1) await service.recordFailure('KC001', null);

    await service.recordSuccess('KC001');

    expect(store.has(userFailureKey('KC001'))).toBe(false);
    // 计数被清掉后,再失败 4 次仍然不该锁
    for (let i = 0; i < 4; i += 1) {
      expect((await service.recordFailure('KC001', null)).locked).toBe(false);
    }
  });

  it('登录成功**不**清 IP 计数 —— 出口 IP 是多人共用的', async () => {
    const { service, store } = createService();
    await service.recordFailure('KC001', '10.0.0.9');

    await service.recordSuccess('KC001');

    // 账号那边的计数清了,IP 这边的必须留着
    expect(store.has(userFailureKey('KC001'))).toBe(false);
    expect(store.has(ipFailureKey('10.0.0.9'))).toBe(true);
  });

  it('IP 那道闸:同一 IP 失败够多也会被挡住', async () => {
    const { service } = createService({
      loginMaxAttempts: 5,
      loginLockMinutes: 15,
      loginIpMaxFailures: 3,
      loginIpWindowMinutes: 15,
    });

    // 每次换一个工号 —— 单账号闸不会触发,只有 IP 闸会
    expect((await service.recordFailure('KC001', '10.0.0.9')).locked).toBe(false);
    expect((await service.recordFailure('KC002', '10.0.0.9')).locked).toBe(false);
    expect((await service.recordFailure('KC003', '10.0.0.9')).locked).toBe(true);

    expect((await service.check('KC004', '10.0.0.9')).locked).toBe(true);
  });

  it('两条闸都关掉(都设 0)时直接放行', async () => {
    const { service, client } = createService({
      loginMaxAttempts: 0,
      loginLockMinutes: 15,
      loginIpMaxFailures: 0,
      loginIpWindowMinutes: 15,
    });

    expect((await service.check('KC001', '10.0.0.9')).locked).toBe(false);
    expect((await service.recordFailure('KC001', '10.0.0.9')).locked).toBe(false);
    expect(client.incr).not.toHaveBeenCalled();
  });

  it('Redis 不可用时降级放行,而不是把所有人挡在门外', async () => {
    const { service, client } = createService();
    client.pttl.mockRejectedValue(new Error('redis down'));
    client.incr.mockRejectedValue(new Error('redis down'));

    expect((await service.check('KC001', null)).locked).toBe(false);
    expect((await service.recordFailure('KC001', null)).locked).toBe(false);
    // 降级时不该抛
    await expect(service.recordSuccess('KC001')).resolves.toBeUndefined();
  });
});
