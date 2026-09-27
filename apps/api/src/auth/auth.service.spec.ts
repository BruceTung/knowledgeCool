/**
 * 认证核心逻辑测试。
 *
 * 重点不在"能不能登录",而在**失败路径不给攻击者额外信息**:
 *   - 工号不存在与密码错误必须返回完全一样的错误
 *   - 工号不存在时也要消耗一次 bcrypt(否则响应快慢就能枚举账号)
 *   - 账号停用后,其已签发的会话必须立刻失效
 */
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';
import { signSetupToken } from './setup-token.js';

const ACTIVE_USER = {
  id: 'u-1',
  employeeNo: 'KC-admin',
  name: '管理员',
  avatarColor: 'gray',
  isSuperAdmin: true,
  passwordHash: '$2b$12$stub',
  status: 'active',
  mustChangePassword: false,
};

function createService(overrides: { userCount?: number } = {}) {
  const prisma = {
    // update 是服务写 last_login_at 用的。桩必须跟着服务走 ——
    // 少了它,服务里那次写会以 TypeError 崩掉,而不是"静默失败"。
    user: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orgAssignment: { findMany: vi.fn() },
    node: { findMany: vi.fn() },
    // 锁定要写审计(auth.login.locked),桩必须跟着服务走。
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.user.count.mockResolvedValue(overrides.userCount ?? 0);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.create.mockResolvedValue(ACTIVE_USER);
  prisma.user.update.mockResolvedValue(ACTIVE_USER);
  prisma.orgAssignment.findMany.mockResolvedValue([]);
  prisma.node.findMany.mockResolvedValue([]);
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

  // 首登改密要签一次性凭证,所以 service 现在依赖 ConfigService。
  // 这只桩只需回答一个问题:密钥是什么。
  const config = {
    get: vi.fn((key: string) => (key === 'sessionSecret' ? 'test-secret' : undefined)),
  };

  // 登录限流。默认"没锁",各用例按需覆盖 ——
  // 这样老的用例不必关心限流,v2.12 新增的用例再显式改它的返回值。
  const throttle = { check: vi.fn(), recordFailure: vi.fn(), recordSuccess: vi.fn() };
  throttle.check.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
  throttle.recordFailure.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
  throttle.recordSuccess.mockResolvedValue(undefined);

  const service = new AuthService(
    prisma as never,
    passwords as never,
    sessions as never,
    config as never,
    throttle as never,
  );
  return { service, prisma, passwords, sessions, config, throttle };
}

describe('AuthService.setup —— 首次初始化', () => {
  it('库为空时创建超管并签发会话', async () => {
    const { service, prisma, sessions } = createService({ userCount: 0 });

    const result = await service.setup(
      { employeeNo: 'KC-admin', name: '管理员', password: 'a-strong-passw0rd' },
      {},
    );

    expect(result.user.isSuperAdmin).toBe(true);
    expect(result.token).toBe('tok');
    expect(sessions.issue).toHaveBeenCalledWith('u-1', {});

    const created = prisma.user.create.mock.calls[0]?.[0];
    expect(created.data.isSuperAdmin).toBe(true);
    // 存进去的必须是哈希,不是明文
    expect(created.data.passwordHash).toBe('$2b$12$hashed');
    expect(JSON.stringify(created)).not.toContain('a-strong-passw0rd');
  });

  it('库中已有用户 → 403,且绝不建号', async () => {
    const { service, prisma } = createService({ userCount: 1 });

    await expect(
      service.setup({ employeeNo: 'KC-x', name: 'x', password: 'a-strong-passw0rd' }, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('并发兜底:事务内再查一次,非空则中止', async () => {
    // 事务外看到 0,事务内看到 1 —— 模拟两个请求同时到达
    const { service, prisma } = createService({ userCount: 0 });
    prisma.user.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(
      service.setup({ employeeNo: 'KC-x', name: 'x', password: 'a-strong-passw0rd' }, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.login —— 不给账号枚举留口子', () => {
  it('密码正确 → 签发会话', async () => {
    const { service, prisma, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    const result = await service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'right' }, {});

    expect(result.response).toMatchObject({
      kind: 'session',
      user: { employeeNo: ACTIVE_USER.employeeNo },
    });
    expect(sessions.issue).toHaveBeenCalledTimes(1);
  });

  // ---------------- v2.12:登录限流与账号锁定 ----------------

  it('已锁定时回 429,且**根本不去查库、也不校验密码**', async () => {
    const { service, prisma, passwords, throttle } = createService();
    throttle.check.mockResolvedValueOnce({ locked: true, retryAfterSeconds: 900 });

    await expect(
      service.login({ employeeNo: 'KC-nobody', password: 'whatever' }, {}),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 900 },
    });

    // 这两条是"锁定期间不校验密码"的证据 —— 只挡结果不挡开销的话,
    // "被锁"与"密码错"的耗时差异又能被用来枚举账号。
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it('限流检查排在 bcrypt 之前', async () => {
    const { service, prisma, passwords, throttle } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    await service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'right' }, {});

    expect(throttle.check.mock.invocationCallOrder[0]).toBeLessThan(
      passwords.verify.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('密码错误 → 记一次失败,并把来源 IP 一起带上(IP 那道闸要用)', async () => {
    const { service, prisma, passwords, throttle } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    passwords.verify.mockResolvedValueOnce(false);

    await expect(
      service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'wrong' }, { ip: '10.0.0.9' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(throttle.recordFailure).toHaveBeenCalledWith(ACTIVE_USER.employeeNo, '10.0.0.9');
  });

  it('登录成功 → 清掉该账号的失败计数,免得零星打错累积成"某天突然被锁"', async () => {
    const { service, prisma, throttle } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    await service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'right' }, {});

    expect(throttle.recordSuccess).toHaveBeenCalledWith(ACTIVE_USER.employeeNo);
  });

  it('这次失败导致锁定、且账号真实存在 → 写一条审计(actor 为空 = 系统判定)', async () => {
    const { service, prisma, passwords, throttle } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    passwords.verify.mockResolvedValueOnce(false);
    throttle.recordFailure.mockResolvedValueOnce({ locked: true, retryAfterSeconds: 900 });

    await expect(
      service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'wrong' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const entry = prisma.auditLog.create.mock.calls[0]?.[0] as {
      data: { action: string; actorId: string | null; targetId: string };
    };
    expect(entry.data.action).toBe('auth.login.locked');
    expect(entry.data.actorId).toBeNull();
    expect(entry.data.targetId).toBe(ACTIVE_USER.id);
  });

  it('工号不存在时不写锁定审计 —— 否则未登录的人能往"只写不删"的审计表里灌数据', async () => {
    const { service, prisma, throttle } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(null);
    throttle.recordFailure.mockResolvedValueOnce({ locked: true, retryAfterSeconds: 900 });

    await expect(
      service.login({ employeeNo: 'KC-nobody', password: 'wrong' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('密码错误 → 401', async () => {
    const { service, prisma, passwords } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    passwords.verify.mockResolvedValueOnce(false);

    await expect(
      service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'wrong' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '工号或密码不正确' });
  });

  it('工号不存在 → 401,**且仍然消耗一次 bcrypt 校验**(抹平时序差异)', async () => {
    const { service, prisma, passwords, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.login({ employeeNo: 'KC-nobody', password: 'x' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '工号或密码不正确' });

    // 关键断言:不能因为"查不到用户"就跳过哈希计算
    expect(passwords.verify).toHaveBeenCalledTimes(1);
    // 而且用来比对的不该是用户输入
    const hashUsed = passwords.verify.mock.calls[0]?.[1];
    expect(hashUsed).not.toBe('x');
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('工号不存在与密码错误的响应完全一致(不可区分)', async () => {
    const a = createService();
    a.prisma.user.findUnique.mockResolvedValueOnce(null);
    const b = createService();
    b.prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    b.passwords.verify.mockResolvedValueOnce(false);

    const errorA = (await a.service
      .login({ employeeNo: 'KC-nobody', password: 'x' }, {})
      .catch((e: unknown) => e)) as unknown as { code: string; message: string };
    const errorB = (await b.service
      .login({ employeeNo: ACTIVE_USER.employeeNo, password: 'x' }, {})
      .catch((e: unknown) => e)) as unknown as { code: string; message: string };

    expect(errorA.code).toBe(errorB.code);
    expect(errorA.message).toBe(errorB.message);
  });

  it('账号被停用 → 401(即使密码正确)', async () => {
    const { service, prisma, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce({ ...ACTIVE_USER, status: 'disabled' });

    await expect(
      service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'right' }, {}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('工号**原样**交给数据库 —— 大小写敏感,不做折叠', async () => {
    // v2.2 起登录标识是工号(text),不再是 citext 邮箱 ——
    // `KC001` 与 `kc001` 是**两个不同的账号**,这里钉住这个行为。
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    await service.login({ employeeNo: 'KC-Admin', password: 'right' }, {});

    expect(prisma.user.findUnique.mock.calls[0]?.[0].where.employeeNo).toBe('KC-Admin');
  });
});

/**
 * v2.4 重做了首次登录这一块。
 *
 * 旧行为:首登照常签发会话,再由守卫拦住所有业务接口 ——
 * 结果是用户卡在一个"半登录态":进不去系统,也退不出去。
 * 现在的语义是干净的:**改密之前没有登录状态**,只有一张 10 分钟的凭证。
 */
describe('AuthService.login —— 首次登录**不建立会话**(v2.4)', () => {
  const FIRST_LOGIN_USER = { ...ACTIVE_USER, mustChangePassword: true };

  it('需要改密时 → 不签发会话,只给一次性凭证', async () => {
    const { service, prisma, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(FIRST_LOGIN_USER);

    const result = await service.login(
      { employeeNo: ACTIVE_USER.employeeNo, password: '123456' },
      {},
    );

    expect(result.response.kind).toBe('password-change-required');
    expect(result.session).toBeUndefined();
    expect(sessions.issue).not.toHaveBeenCalled();

    if (result.response.kind === 'password-change-required') {
      // 凭证是「payload.签名」两段式
      expect(result.response.setupToken.split('.')).toHaveLength(2);
      expect(result.response.employeeNo).toBe(ACTIVE_USER.employeeNo);
    }
  });

  it('需要改密时**不写** `last_login_at` —— 他还没进过系统', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(FIRST_LOGIN_USER);

    await service.login({ employeeNo: ACTIVE_USER.employeeNo, password: '123456' }, {});

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('未配置 SESSION_SECRET → 明确报错,而**不是**降级放行', async () => {
    // 用空密钥去签等于任何人都能伪造凭证 —— 那比"首登改密暂时不可用"严重得多。
    const { service, prisma, config } = createService();
    config.get.mockReturnValue(undefined);
    prisma.user.findUnique.mockResolvedValueOnce(FIRST_LOGIN_USER);

    await expect(
      service.login({ employeeNo: ACTIVE_USER.employeeNo, password: '123456' }, {}),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('AuthService.setInitialPassword —— 首次改密', () => {
  const PENDING = { id: 'u-1', status: 'active', mustChangePassword: true };

  it('凭证有效 → 写入新密码并清掉待改密标记', async () => {
    const { service, prisma } = createService();
    const { token } = signSetupToken('u-1', 'test-secret');
    prisma.user.findUnique.mockResolvedValueOnce(PENDING);

    await service.setInitialPassword({ setupToken: token, newPassword: 'a-strong-passw0rd' });

    const update = prisma.user.update.mock.calls[0]?.[0];
    expect(update.where).toEqual({ id: 'u-1' });
    expect(update.data.mustChangePassword).toBe(false);
    // 存的是哈希,不是明文
    expect(update.data.passwordHash).toBe('$2b$12$hashed');
    expect(JSON.stringify(update)).not.toContain('a-strong-passw0rd');
  });

  it('伪造的凭证 → 401', async () => {
    const { service } = createService();
    await expect(
      service.setInitialPassword({ setupToken: 'fake.payload', newPassword: 'a-strong-passw0rd' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('用别的密钥签的凭证 → 401', async () => {
    const { service } = createService();
    const { token } = signSetupToken('u-1', 'attacker-secret');
    await expect(
      service.setInitialPassword({ setupToken: token, newPassword: 'a-strong-passw0rd' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('已经改过密 → 凭证作废(这就是"一次性"的落地方式)', async () => {
    // 不需要服务端记"这张用过了" —— 用户状态本身就把凭证作废了。
    const { service, prisma } = createService();
    const { token } = signSetupToken('u-1', 'test-secret');
    prisma.user.findUnique.mockResolvedValueOnce({ ...PENDING, mustChangePassword: false });

    await expect(
      service.setInitialPassword({ setupToken: token, newPassword: 'a-strong-passw0rd' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('新密码太弱 → 400(强度规则与主动改密完全一致)', async () => {
    const { service, prisma } = createService();
    const { token } = signSetupToken('u-1', 'test-secret');
    prisma.user.findUnique.mockResolvedValueOnce(PENDING);

    await expect(
      service.setInitialPassword({ setupToken: token, newPassword: '12345678' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.resolveUserBySessionToken', () => {
  it('无会话 → null', async () => {
    const { service } = createService();
    await expect(service.resolveUserBySessionToken('tok')).resolves.toBeNull();
  });

  it('会话有效且账号正常 → 返回用户,且不带出密码哈希', async () => {
    const { service, prisma, sessions } = createService();
    sessions.resolve.mockResolvedValueOnce({ sessionId: 's', userId: 'u-1' });
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);

    const user = await service.resolveUserBySessionToken('tok');
    expect(user?.id).toBe('u-1');
    expect(user).not.toHaveProperty('passwordHash');
    // ⚠️ `status` 是**要**带出去的(v2.2):守卫靠它挡掉已离职 / 已停用的账号,
    // 前端也要用它显示「已离职」。它不含敏感信息 —— 真正不该出去的是密码哈希。
    expect(user?.status).toBe('active');
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

describe('AuthService.me —— 组织归属', () => {
  it('把归属节点的路径渲染成「技术部 / 后端组」', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    prisma.orgAssignment.findMany.mockResolvedValueOnce([
      { node: { id: 'n-1', materializedPath: '/n-1' } },
      { node: { id: 'n-2', materializedPath: '/n-1/n-2' } },
    ]);
    prisma.node.findMany.mockResolvedValueOnce([
      { id: 'n-1', title: '技术部' },
      { id: 'n-2', title: '后端组' },
    ]);

    const result = await service.me('u-1');

    expect(result.user.id).toBe('u-1');
    expect(result.scopes.map((scope) => scope.path)).toEqual(['技术部', '技术部 / 后端组']);
  });

  it('没有归属时返回空数组,而不是报错', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    prisma.orgAssignment.findMany.mockResolvedValueOnce([]);

    const result = await service.me('u-1');

    expect(result.scopes).toEqual([]);
    // 没有归属就不该去查节点标题 —— 省一次无用查询
    expect(prisma.node.findMany).not.toHaveBeenCalled();
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

    await service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'right' }, {});

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const call = prisma.user.update.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: 'u-1' });
    expect(call.data.lastLoginAt).toBeInstanceOf(Date);
  });

  it('首次初始化也写入 —— 初始化本身就是一次登录', async () => {
    const { service, prisma } = createService({ userCount: 0 });

    await service.setup(
      { employeeNo: 'KC-admin', name: '管理员', password: 'a-strong-passw0rd' },
      {},
    );

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('写失败不影响登录成功 —— 它只是审计元数据,不该把一次正常登录变成 500', async () => {
    const { service, prisma, sessions } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(ACTIVE_USER);
    prisma.user.update.mockRejectedValueOnce(new Error('数据库写失败'));

    await expect(
      service.login({ employeeNo: ACTIVE_USER.employeeNo, password: 'right' }, {}),
    ).resolves.toBeDefined();
    expect(sessions.issue).toHaveBeenCalledTimes(1);
  });
});
