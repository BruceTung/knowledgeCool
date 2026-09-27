/**
 * OrgService 的**守卫**测试(v2.14)—— 此前零测试。
 *
 * 这里只挑"错了后果很重"的三条,它们都属于"代码写得很对、但没人证明过"的那类:
 *
 *   1. **不能把最后一个在职管理员停用 / 离职。** 写错了会把系统锁死 ——
 *      没人能再维护组织架构,而且**没有界面能救回来**(要连数据库改)。
 *   2. **不能重置自己的密码。** 能点这个按钮说明他正登着;允许它只会制造一次手滑:
 *      他会立刻被踢下线,然后要用 123456 登回来再改一遍。
 *   3. **不能重置一个登不进来的人的密码。** 那是白做工,而且会让人以为
 *      "重置了怎么还是登不上" —— 真正的原因(他已离职)必须说出来。
 *
 * 另外验一条通用的:**所有管理动作都要超管**,非超管连"看一眼"都不行。
 */
import { describe, expect, it, vi } from 'vitest';

import type { Actor } from '@knowledgecool/shared';

import { OrgService } from './org.service.js';

const ADMIN: Actor = { id: 'u-super', isSuperAdmin: true };
const NOBODY: Actor = { id: 'u-normal', isSuperAdmin: false };

function createFixture(
  existing: { id: string; status: string; isSuperAdmin: boolean } | null,
  otherActiveAdmins = 0,
) {
  /*
    返回的行必须与 `USER_VIEW_SELECT` 的字段**逐一对上**,而且带 assignments ——
    因为成功路径最后要调 `viewOf` 组装响应。
    我第一版让 update 返回 `{ id }`,于是五条"应该成功"的用例全挂在 `toViews` 里,
    而**守卫那几条是通过的** —— 失败信息指向的是我的桩不全,不是实现有问题。
  */
  const fullRow = {
    id: existing?.id ?? 'u-1',
    employeeNo: 'KC002',
    name: '某人',
    // ⚠️ 必须**照抄传进来的 status**,不能写死 active ——
    // 我第一版写死了,于是"已离职的人不该能重置密码"那条查到的永远是 active,
    // 守卫根本没被触发,用例就红了。桩把被测逻辑的输入改掉,是最隐蔽的一类自欺。
    status: existing?.status ?? 'active',
    isSuperAdmin: existing?.isSuperAdmin ?? false,
    mustChangePassword: false,
    lastLoginAt: null,
    assignments: [] as unknown[],
  };
  const prisma = {
    user: {
      findUnique: vi.fn(async () => (existing === null ? null : fullRow)),
      count: vi.fn(async () => otherActiveAdmins),
      update: vi.fn(async () => fullRow),
    },
    session: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops as Promise<unknown>[]) : (ops as () => unknown)(),
    ),
    node: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => undefined) },
  };
  const permissions = { access: vi.fn(), requireRead: vi.fn(), isInOperatorScope: vi.fn() };
  const passwords = { hash: vi.fn(async () => 'hash') };
  return {
    service: new OrgService(prisma as never, permissions as never, passwords as never),
    prisma,
  };
}

describe('OrgService —— 所有管理动作都要超管', () => {
  it('★ 非超管:列人员 / 建人 / 改状态 / 重置密码 一律 403', async () => {
    const { service } = createFixture(null);
    await expect(service.listUsers(NOBODY)).rejects.toThrow(/只有管理员/);
    await expect(service.createUser(NOBODY, { employeeNo: 'KC999', name: '某人' })).rejects.toThrow(
      /只有管理员/,
    );
    await expect(service.updateUser(NOBODY, 'u-1', {})).rejects.toThrow(/只有管理员/);
    await expect(service.resetPassword(NOBODY, 'u-1')).rejects.toThrow(/只有管理员/);
  });
});

describe('OrgService.updateUser —— 不能把系统锁死', () => {
  it('★★ 最后一个在职管理员改成离职 → 拒,并说清原因', async () => {
    // 写错了的后果比"某个操作不好用"严重得多:没有界面能把它改回来。
    const { service, prisma } = createFixture(
      { id: 'u-1', status: 'active', isSuperAdmin: true },
      0,
    );
    await expect(service.updateUser(ADMIN, 'u-1', { status: 'departed' })).rejects.toThrow(
      /最后一个在职的管理员/,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('★ 还有别的在职管理员时,允许改成离职', async () => {
    const { service, prisma } = createFixture(
      { id: 'u-1', status: 'active', isSuperAdmin: true },
      1,
    );
    await service.updateUser(ADMIN, 'u-1', { status: 'departed' });
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('★ 改成 active 不受这条限制(恢复不会锁死系统)', async () => {
    const { service, prisma } = createFixture(
      { id: 'u-1', status: 'departed', isSuperAdmin: true },
      0,
    );
    await service.updateUser(ADMIN, 'u-1', { status: 'active' });
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('★ 停用 / 离职要立刻吊销会话(否则他手里那个会话还能用)', async () => {
    const { service, prisma } = createFixture(
      { id: 'u-1', status: 'active', isSuperAdmin: false },
    );
    await service.updateUser(ADMIN, 'u-1', { status: 'disabled' });
    expect(prisma.session.deleteMany).toHaveBeenCalled();
  });

  it('只改名字时**不要**动会话(否则每次改名都把人在线踢掉)', async () => {
    const { service, prisma } = createFixture(
      { id: 'u-1', status: 'active', isSuperAdmin: false },
    );
    await service.updateUser(ADMIN, 'u-1', { name: '新名字' });
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });
});

describe('OrgService.resetPassword —— 两条"白做工"要拦在前面', () => {
  it('★ 不能重置自己的密码(能登着说明他不需要,而这一步会把他踢下线)', async () => {
    const { service, prisma } = createFixture(
      { id: 'u-super', status: 'active', isSuperAdmin: true },
    );
    await expect(service.resetPassword(ADMIN, 'u-super')).rejects.toThrow(/不能重置自己/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('★ 已离职的人:拒,并**说出真正的原因**(而不是让他以为重置成功了)', async () => {
    const { service } = createFixture({
      id: 'u-2',
      status: 'departed',
      isSuperAdmin: false,
    });
    await expect(service.resetPassword(ADMIN, 'u-2')).rejects.toThrow(/已离职/);
  });

  it('在职的人:允许重置', async () => {
    const { service, prisma } = createFixture({
      id: 'u-2',
      status: 'active',
      isSuperAdmin: false,
    });
    await service.resetPassword(ADMIN, 'u-2');
    expect(prisma.user.update).toHaveBeenCalled();
  });
});

describe('OrgService.createUser', () => {
  it('工号为空 → 拒(而不是建出一个工号为空的账号)', async () => {
    const { service } = createFixture(null);
    await expect(service.createUser(ADMIN, { employeeNo: '   ', name: '某人' })).rejects.toThrow(
      /工号不能为空/,
    );
  });
});
