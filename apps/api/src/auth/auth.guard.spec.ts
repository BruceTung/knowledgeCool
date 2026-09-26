/**
 * 全局鉴权守卫测试。
 *
 * 这个守卫注册为 APP_GUARD(默认一切接口都要登录),所以它的**默认行为**就是安全边界:
 * 一旦漏判,整个 API 会变成未授权可访问,而且功能测试全都还是绿的。
 */
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AuthGuard } from './auth.guard.js';

const ACTIVE_USER = {
  id: 'u-1',
  employeeNo: 'KC001',
  name: '某人',
  avatarColor: 'gray',
  isSuperAdmin: false,
  status: 'active',
  mustChangePassword: false,
};

function createContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function createGuard(options: {
  isPublic?: boolean;
  resolveUser?: unknown;
}) {
  const reflector = {
    getAllAndOverride: vi.fn(() => options.isPublic ?? false),
  };
  const auth = {
    resolveUserBySessionToken: vi.fn(() => Promise.resolve(options.resolveUser ?? null)),
    revokeSession: vi.fn(() => Promise.resolve()),
  };
  const guard = new AuthGuard(reflector as never, auth as never);
  return { guard, reflector, auth };
}

describe('AuthGuard', () => {
  it('@Public() 路由直接放行,连会话都不查', async () => {
    const { guard, auth } = createGuard({ isPublic: true });

    await expect(guard.canActivate(createContext({}))).resolves.toBe(true);
    expect(auth.resolveUserBySessionToken).not.toHaveBeenCalled();
  });

  it('没有 Cookie → 401', async () => {
    const { guard } = createGuard({});
    await expect(guard.canActivate(createContext({ cookies: {} }))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('cookies 整个缺失(未经 cookie-parser)→ 401,不抛 TypeError', async () => {
    const { guard } = createGuard({});
    await expect(guard.canActivate(createContext({}))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('Cookie 值为空字符串 → 401', async () => {
    const { guard } = createGuard({});
    await expect(
      guard.canActivate(createContext({ cookies: { kc_session: '' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('Cookie 值不是字符串 → 401(不把数组之类的怪值喂给会话服务)', async () => {
    const { guard } = createGuard({});
    await expect(
      guard.canActivate(createContext({ cookies: { kc_session: ['a', 'b'] } })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('会话无效 / 已过期 → 401', async () => {
    const { guard, auth } = createGuard({ resolveUser: null });

    await expect(
      guard.canActivate(createContext({ cookies: { kc_session: 'stale' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(auth.resolveUserBySessionToken).toHaveBeenCalledWith('stale');
  });

  it('会话有效 → 放行,并把 user 与 sessionToken 挂到请求上', async () => {
    const { guard } = createGuard({ resolveUser: ACTIVE_USER });
    const request: Record<string, unknown> = { cookies: { kc_session: 'good' } };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toEqual(ACTIVE_USER);
    // 登出需要原始 token
    expect(request.sessionToken).toBe('good');
  });

  it('未登录与"会话过期"返回的是同一个错误(不给额外信息)', async () => {
    const noCookie = createGuard({});
    const stale = createGuard({ resolveUser: null });

    const a = (await noCookie.guard
      .canActivate(createContext({ cookies: {} }))
      .catch((e: unknown) => e)) as { code: string; message: string };
    const b = (await stale.guard
      .canActivate(createContext({ cookies: { kc_session: 'x' } }))
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(a.code).toBe(b.code);
    expect(a.message).toBe(b.message);
  });

  it('有会话却仍待改密 → 吊销会话并按**未登录**处理(纵深防御)', async () => {
    // ⚠️ 按当前流程这种状态**不可能**出现:首次登录不发会话、
    // 建人不发会话、重置密码的脚本会踢掉会话。
    // 但万一出现(例如有人手工改库),必须让"半登录态"不可能存在 ——
    // 而不是放他进来再逐个接口去判。v2.4 之前正是那种做法,还因此漏过一次白名单。
    const { guard, auth } = createGuard({
      resolveUser: { ...ACTIVE_USER, mustChangePassword: true },
    });

    await expect(
      guard.canActivate(createContext({ cookies: { kc_session: 'weird' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(auth.revokeSession).toHaveBeenCalledWith('weird');
  });
});
