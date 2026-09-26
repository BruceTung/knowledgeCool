/**
 * 会话服务测试。
 *
 * 最要紧的一条:**库里存的必须是 token 的哈希,不能是 token 本身**。
 * 这条如果坏了,数据库一旦泄露就等于所有人会话被直接接管,
 * 而且不会有任何报错 —— 属于"错了不会立刻发现"的类型。
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionService } from './session.service.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function createService() {
  const session = {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  session.create.mockResolvedValue({});
  session.findUnique.mockResolvedValue(null);
  session.update.mockResolvedValue({});
  session.delete.mockResolvedValue({});
  session.deleteMany.mockResolvedValue({ count: 0 });

  const prisma = { session };
  const config = { get: (key: string) => (key === 'sessionTtlHours' ? 24 : undefined) };
  const service = new SessionService(prisma as never, config as never);
  return { service, session };
}

describe('SessionService.issue', () => {
  it('返回高熵 token,且入库的是它的 sha256 而非 token 本身', async () => {
    const { service, session } = createService();

    const issued = await service.issue('user-1');

    // 32 字节熵 → base64url 至少 43 字符
    expect(issued.token.length).toBeGreaterThanOrEqual(43);

    const created = session.create.mock.calls[0]?.[0];
    expect(created.data.userId).toBe('user-1');
    expect(created.data.id).toBe(sha256(issued.token));

    // 关键断言:库里的主键绝不能等于 token
    expect(created.data.id).not.toBe(issued.token);
    expect(JSON.stringify(created)).not.toContain(issued.token);
  });

  it('两次签发的 token 不同', async () => {
    const { service } = createService();
    const a = await service.issue('u');
    const b = await service.issue('u');
    expect(a.token).not.toBe(b.token);
  });

  it('过期时间按配置的 TTL 推算(本用例配置为 24 小时)', async () => {
    const { service } = createService();
    const before = Date.now();
    const issued = await service.issue('u');
    const deltaHours = (issued.expiresAt.getTime() - before) / 3_600_000;
    expect(deltaHours).toBeGreaterThan(23.9);
    expect(deltaHours).toBeLessThan(24.1);
  });

  it('记录 userAgent 与 ip,缺省时写 null', async () => {
    const { service, session } = createService();
    await service.issue('u', { userAgent: 'vitest', ip: '10.0.0.1' });
    expect(session.create.mock.calls[0]?.[0].data.userAgent).toBe('vitest');
    expect(session.create.mock.calls[0]?.[0].data.ip).toBe('10.0.0.1');

    await service.issue('u');
    expect(session.create.mock.calls[1]?.[0].data.userAgent).toBeNull();
    expect(session.create.mock.calls[1]?.[0].data.ip).toBeNull();
  });
});

describe('SessionService.resolve', () => {
  it('token 不存在 → null', async () => {
    const { service } = createService();
    await expect(service.resolve('nope')).resolves.toBeNull();
  });

  it('按 sha256 查库(而不是拿 token 直接查)', async () => {
    const { service, session } = createService();
    await service.resolve('some-token');
    expect(session.findUnique.mock.calls[0]?.[0].where.id).toBe(sha256('some-token'));
  });

  it('未过期 → 返回 userId 与 sessionId', async () => {
    const { service, session } = createService();
    session.findUnique.mockResolvedValueOnce({
      userId: 'user-9',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
    });

    await expect(service.resolve('t')).resolves.toEqual({
      sessionId: sha256('t'),
      userId: 'user-9',
    });
  });

  it('已过期 → null,并顺手删掉该行', async () => {
    const { service, session } = createService();
    session.findUnique.mockResolvedValueOnce({
      userId: 'user-9',
      expiresAt: new Date(Date.now() - 1_000),
      lastSeenAt: new Date(Date.now() - 1_000),
    });

    await expect(service.resolve('t')).resolves.toBeNull();
    expect(session.delete).toHaveBeenCalledTimes(1);
  });

  it('lastSeenAt 写回有节流:刚更新过就不再写', async () => {
    const { service, session } = createService();
    session.findUnique.mockResolvedValueOnce({
      userId: 'u',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
    });

    await service.resolve('t');
    expect(session.update).not.toHaveBeenCalled();
  });

  it('lastSeenAt 超过节流窗口 → 写回一次', async () => {
    const { service, session } = createService();
    session.findUnique.mockResolvedValueOnce({
      userId: 'u',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    await service.resolve('t');
    expect(session.update).toHaveBeenCalledTimes(1);
  });
});

describe('SessionService 吊销', () => {
  it('revoke 按哈希删行', async () => {
    const { service, session } = createService();
    await service.revoke('tok');
    expect(session.delete.mock.calls[0]?.[0].where.id).toBe(sha256('tok'));
  });

  it('revokeAllForUser 按 userId 批量删 —— 这是选服务端会话换来的能力', async () => {
    const { service, session } = createService();
    session.deleteMany.mockResolvedValueOnce({ count: 3 });
    await expect(service.revokeAllForUser('u-1')).resolves.toBe(3);
    expect(session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1' } });
  });

  it('purgeExpired 只删已过期的', async () => {
    const { service, session } = createService();
    await service.purgeExpired();
    const arg = session.deleteMany.mock.calls[0]?.[0];
    expect(arg.where.expiresAt.lte.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('token 随机性', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1000 次抽样无碰撞', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(randomBytes(32).toString('base64url'));
    expect(seen.size).toBe(1000);
  });
});
