/**
 * 认证核心逻辑测试。
 *
 * 重点不在"能不能登录",而在**失败路径不给攻击者额外信息**:
 *   - 邮箱不存在与密码错误必须返回完全一样的错误
 *   - 邮箱不存在时也要消耗一次 bcrypt(否则响应快慢就能枚举账号)
 *   - 账号停用后,其已签发的会话必须立刻失效
 */
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

const ACTIVE_USER = {
  id: 'u-1',
  email: 'admin@example.com',
  name: '管理员',
  department: '产品部',
  avatarColor: 'gray',
  isSuperAdmin: true,
  passwordHash: '$2b$12$stub',
  status: 'active',
};

function createService(overrides: { userCount?: number } = {}) {
  const prisma = {
    // update 是服务写 last_login_at 用的。桩必须跟着服务走 ——
    // 少了它,服务里那次写会以 TypeError 崩掉,而不是"静默失败"。
    user: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    spaceMember: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.user.count.mockResolvedValue(overrides.userCount ?? 0);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.create.mockResolvedValue(ACTIVE_USER);
  prisma.user.update.mockResolvedValue(ACTIVE_USER);
  prisma.spaceMember.findMany.mockResolvedValue([]);
  // 事务桩:把同一套桩当 tx 传进回调,便于断言事务内的行为
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

  const passwords = { hash: vi.fn(), verify: vi.fn() };
  passwords.hash.mockResolvedValue('$2b$12$hashed');
  passwords.verify.mockResolvedValue(true);

  const sessions = {
    issue: vi.fn(),
    resolve: vi.fn(),
    revoke: vi.fn(),
    revokeAllForUser: vi.fn(),
    purgeExpired: vi.fn(),
  };
  sessions.issue.mockResolvedValue({ token: 'tok', expiresAt: new Date(Date.now() + 1000) });
  sessions.resolve.mockResolvedValue(null);
  sessions.revoke.mockResolvedValue(undefined);
  sessions.revokeAllForUser.mockResolvedValue(1);
  sessions.purgeExpired.mockResolvedValue(0);

  const service = new AuthService(prisma as never, passwords as never, sessions as never);
  return { service, prisma, passwords, sessions };
}

describe('AuthService.setup —— 首次初始化', () => {
  it('库为空时创建超管并签发会话', async () => {
    const { service, prisma, sessions } = createService({ userCount: 0 });

    const result = await service.setup(
      { email: 'admin@example.com', name: '管理员', password: 'a-strong-password' },
      {},
    );

    expect(result.user.isSuperAdmin).toBe(true);
    expect(result.token).toBe('tok');
    expect(sessions.issue).toHaveBeenCalledWith('u-1', {});

    const created = prisma.user.create.mock.calls[0]?.[0];
    expect(created.data.isSuperAdmin).toBe(true);
    // 存进去的必须是哈希,不是明文
    expect(created.data.passwordHash).toBe('$2b$12$hashed');
    expect(JSON.stringify(created)).not.toContain('a-strong-password');
  });

  it('库中已有用户 → 403,且绝不建号', async () => {
    const { service, prisma } = createService({ userCount: 1 });

    await expect(
      service.setup({ email: 'x@example.com', name: 'x', password: 'a-strong-password' }, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('并发兜底:事务内再查一次,非空则中止', async () => {
    // 事务外看到 0,事务内看到 1 —— 模拟两个请求同时到达
    const { service, prisma } = createService({ userCount: 0 });
    prisma.user.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(
      service.setup({ email: 'x@example.com', name: 'x', password: 'a-strong-password' }, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.login —— 不给账号枚举留口子', () => {
  it('密码正确 → 签发会话', async () => {
    const { service, prisma, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    const result = await service.login({ email: ACTIVE_USER.email, password: 'right' }, {});

    expect(result.user.email).toBe(ACTIVE_USER.email);
    expect(sessions.issue).toHaveBeenCalledTimes(1);
  });

  it('密码错误 → 401', async () => {
    const { service, prisma, passwords } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    passwords.verify.mockResolvedValueOnce(false);

    await expect(
      service.login({ email: ACTIVE_USER.email, password: 'wrong' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '邮箱或密码不正确' });
  });

  it('邮箱不存在 → 401,**且仍然消耗一次 bcrypt 校验**(抹平时序差异)', async () => {
    const { service, prisma, passwords, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.login({ email: 'nobody@example.com', password: 'x' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '邮箱或密码不正确' });

    // 关键断言:不能因为"查不到用户"就跳过哈希计算
    expect(passwords.verify).toHaveBeenCalledTimes(1);
    // 而且用来比对的不该是用户输入
    const hashUsed = passwords.verify.mock.calls[0]?.[1];
    expect(hashUsed).not.toBe('x');
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('邮箱不存在与密码错误的响应完全一致(不可区分)', async () => {
    const a = createService();
    a.prisma.user.findUnique.mockResolvedValueOnce(null);
    const b = createService();
    b.prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    b.passwords.verify.mockResolvedValueOnce(false);

    const errorA = (await a.service
      .login({ email: 'nobody@example.com', password: 'x' }, {})
      .catch((e: unknown) => e)) as unknown as { code: string; message: string };
    const errorB = (await b.service
      .login({ email: ACTIVE_USER.email, password: 'x' }, {})
      .catch((e: unknown) => e)) as unknown as { code: string; message: string };

    expect(errorA.code).toBe(errorB.code);
    expect(errorA.message).toBe(errorB.message);
  });

  it('账号被停用 → 401(即使密码正确)', async () => {
    const { service, prisma, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce({ ...ACTIVE_USER, status: 'disabled' });

    await expect(
      service.login({ email: ACTIVE_USER.email, password: 'right' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('邮箱原样交给数据库,由 citext 做大小写折叠', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    await service.login({ email: 'ADMIN@Example.COM', password: 'right' }, {});

    expect(prisma.user.findUnique.mock.calls[0]?.[0].where.email).toBe('ADMIN@Example.COM');
  });
});

describe('AuthService.resolveUserBySessionToken', () => {
  it('无会话 → null', async () => {
    const { service } = createService();
    await expect(service.resolveUserBySessionToken('tok')).resolves.toBeNull();
  });

  it('会话有效且账号正常 → 返回用户,且不带出哈希与状态', async () => {
    const { service, prisma, sessions } = createService();
    sessions.resolve.mockResolvedValueOnce({ sessionId: 's', userId: 'u-1' });
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    const user = await service.resolveUserBySessionToken('tok');
    expect(user?.id).toBe('u-1');
    expect(user).not.toHaveProperty('passwordHash');
    expect(user).not.toHaveProperty('status');
  });

  it('账号已停用 → null,并吊销其全部会话', async () => {
    const { service, prisma, sessions } = createService();
    sessions.resolve.mockResolvedValueOnce({ sessionId: 's', userId: 'u-1' });
    prisma.user.findUnique.mockResolvedValueOnce({ ...ACTIVE_USER, status: 'disabled' });

    await expect(service.resolveUserBySessionToken('tok')).resolves.toBeNull();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u-1');
  });

  it('用户已被删除 → null 且吊销会话', async () => {
    const { service, prisma, sessions } = createService();
    sessions.resolve.mockResolvedValueOnce({ sessionId: 's', userId: 'gone' });
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(service.resolveUserBySessionToken('tok')).resolves.toBeNull();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('gone');
  });
});

describe('AuthService.me —— 可见空间列表', () => {
  it('返回用户与其空间角色', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    prisma.spaceMember.findMany.mockResolvedValueOnce([
      { role: 'admin', space: { id: 's-1', name: '产品', slug: 'product', letter: '产', color: 'blue' } },
      { role: 'viewer', space: { id: 's-2', name: '研发', slug: 'dev', letter: '研', color: 'green' } },
    ]);

    const result = await service.me('u-1');

    expect(result.user.id).toBe('u-1');
    expect(result.spaces.map((s) => s.role)).toEqual(['admin', 'viewer']);
  });

  it('角色值异常时跳过该空间,而不是兜底成某个角色', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    prisma.spaceMember.findMany.mockResolvedValueOnce([
      { role: 'owner', space: { id: 's-1', name: 'X', slug: 'x', letter: 'X', color: 'blue' } },
      { role: 'viewer', space: { id: 's-2', name: 'Y', slug: 'y', letter: 'Y', color: 'blue' } },
    ]);

    const result = await service.me('u-1');

    // 权限相关的兜底必须偏向"不给"
    expect(result.spaces.map((s) => s.id)).toEqual(['s-2']);
  });

  it('用户不存在 → NOT_FOUND', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(service.me('gone')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AuthService.isInitialized', () => {
  it('无用户 → false', async () => {
    const { service } = createService({ userCount: 0 });
    await expect(service.isInitialized()).resolves.toBe(false);
  });

  it('有用户 → true', async () => {
    const { service } = createService({ userCount: 2 });
    await expect(service.isInitialized()).resolves.toBe(true);
  });
});

describe('last_login_at 写入(此前是死字段)', () => {
  it('登录成功后写入 lastLoginAt', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    await service.login({ email: ACTIVE_USER.email, password: 'right' }, {});

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const call = prisma.user.update.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: 'u-1' });
    expect(call.data.lastLoginAt).toBeInstanceOf(Date);
  });

  it('首次初始化也写入 —— 初始化本身就是一次登录', async () => {
    const { service, prisma } = createService({ userCount: 0 });

    await service.setup(
      { email: 'admin@example.com', name: '管理员', password: 'a-strong-password' },
      {},
    );

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('写失败不影响登录成功 —— 它只是审计元数据,不该把一次正常登录变成 500', async () => {
    const { service, prisma, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    prisma.user.update.mockRejectedValueOnce(new Error('数据库写失败'));

    await expect(
      service.login({ email: ACTIVE_USER.email, password: 'right' }, {}),
    ).resolves.toBeDefined();
    expect(sessions.issue).toHaveBeenCalledTimes(1);
  });
});
