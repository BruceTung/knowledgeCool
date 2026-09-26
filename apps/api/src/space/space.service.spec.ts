/**
 * 空间与成员服务测试。
 *
 * 重点不在"能不能用",而在**几条错了不会立刻报错的规则**:
 *   - 非成员必须得到 NOT_FOUND 而不是 FORBIDDEN(§5.3 最小可见)
 *   - 所有者不能被降级 / 移除(阶段一没有转移所有权)
 *   - 最后一个管理员不能被降级 / 移除(否则空间成为死结)
 *   - 邀请一个不存在的邮箱时,明文密码绝不能进 create
 *
 * 这些都是「一旦写错,当下没有任何报错,几周后才炸」的类型(DESIGN.md §12)。
 */
import { describe, expect, it, vi } from 'vitest';

import { SpaceService } from './space.service.js';

const SPACE_ROW = {
  id: 'sp-1',
  name: '研发中心',
  slug: 'space',
  letter: '研',
  color: 'blue',
  ownerId: 'u-owner',
};

const VIEWER: { id: string; isSuperAdmin: boolean } = { id: 'u-viewer', isSuperAdmin: false };
const ADMIN: { id: string; isSuperAdmin: boolean } = { id: 'u-admin', isSuperAdmin: false };
const SUPER: { id: string; isSuperAdmin: boolean } = { id: 'u-super', isSuperAdmin: true };

function memberRow(userId: string, role: string, createdAt = '2026-09-01T00:00:00.000Z') {
  return {
    role,
    createdAt: new Date(createdAt),
    user: {
      id: userId,
      email: `${userId}@corp.cn`,
      name: userId,
      department: null,
      avatarColor: 'blue',
    },
  };
}

function createService() {
  const prisma = {
    user: { findUnique: vi.fn(), create: vi.fn() },
    space: { findUnique: vi.fn(), create: vi.fn() },
    spaceMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  // 事务桩:把同一套桩当 tx 传进回调,便于断言事务内的行为。
  // 注意要接受第二个参数(isolationLevel),服务用它开了 Serializable。
  prisma.$transaction.mockImplementation(
    async (cb: (tx: unknown) => unknown) => cb(prisma),
  );

  prisma.space.findUnique.mockResolvedValue(null);
  prisma.space.create.mockResolvedValue(SPACE_ROW);
  prisma.spaceMember.findMany.mockResolvedValue([]);
  prisma.spaceMember.findUnique.mockResolvedValue(null);
  prisma.spaceMember.create.mockImplementation(async (args: { data: { role: string } }) =>
    memberRow('u-new', args.data.role),
  );
  prisma.spaceMember.count.mockResolvedValue(1);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.create.mockResolvedValue({ id: 'u-new' });

  const passwords = { hash: vi.fn(), verify: vi.fn() };
  passwords.hash.mockResolvedValue('$2b$12$hashed');

  const service = new SpaceService(prisma as never, passwords as never);
  return { service, prisma, passwords };
}

/** 桩:「操作者在空间里的角色是 X」——即 requireVisible 内的那次查询。 */
function stubActorRole(
  prisma: ReturnType<typeof createService>['prisma'],
  role: string | null,
) {
  prisma.space.findUnique.mockResolvedValueOnce(SPACE_ROW);
  prisma.spaceMember.findUnique.mockResolvedValueOnce(role === null ? null : { role });
}

// ======================================================================

describe('SpaceService.listForUser', () => {
  it('返回我可见的空间,带成员数', async () => {
    const { service, prisma } = createService();
    prisma.spaceMember.findMany.mockResolvedValueOnce([
      {
        role: 'admin',
        space: {
          id: 'sp-1',
          name: '研发中心',
          slug: 'dev',
          letter: '研',
          color: 'blue',
          _count: { members: 5 },
        },
      },
    ]);

    const result = await service.listForUser(VIEWER);

    expect(result).toEqual([
      {
        id: 'sp-1',
        name: '研发中心',
        slug: 'dev',
        letter: '研',
        color: 'blue',
        role: 'admin',
        memberCount: 5,
      },
    ]);
  });

  it('只查「我是成员」的空间 —— 超管也不会看到全部空间', async () => {
    const { service, prisma } = createService();

    await service.listForUser(SUPER);

    expect(prisma.spaceMember.findMany.mock.calls[0]?.[0].where).toEqual({ userId: 'u-super' });
  });

  it('角色值异常时跳过该空间,而不是兜底授予角色', async () => {
    const { service, prisma } = createService();
    prisma.spaceMember.findMany.mockResolvedValueOnce([
      {
        role: 'owner',
        space: { id: 'sp-x', name: 'X', slug: 'x', letter: 'X', color: 'blue', _count: { members: 1 } },
      },
      {
        role: 'viewer',
        space: { id: 'sp-y', name: 'Y', slug: 'y', letter: 'Y', color: 'blue', _count: { members: 2 } },
      },
    ]);

    const result = await service.listForUser(VIEWER);

    expect(result.map((s) => s.id)).toEqual(['sp-y']);
  });
});

// ======================================================================

describe('SpaceService.create', () => {
  it('创建者同时成为所有者与空间管理员(否则新空间没人能管)', async () => {
    const { service, prisma } = createService();

    const result = await service.create(ADMIN, { name: '研发中心' });

    const created = prisma.space.create.mock.calls[0]?.[0];
    expect(created.data.ownerId).toBe('u-admin');
    expect(prisma.spaceMember.create).toHaveBeenCalledWith({
      data: { spaceId: 'sp-1', userId: 'u-admin', role: 'admin' },
    });
    expect(result.role).toBe('admin');
    expect(result.memberCount).toBe(1);
  });

  it('名称首字自动成为标识字,不必让管理员手填', async () => {
    const { service, prisma } = createService();

    await service.create(ADMIN, { name: '研发中心' });

    expect(prisma.space.create.mock.calls[0]?.[0].data.letter).toBe('研');
  });

  it('ASCII 名称可转写出可读 slug', async () => {
    const { service, prisma } = createService();

    await service.create(ADMIN, { name: 'Product Docs' });

    expect(prisma.space.create.mock.calls[0]?.[0].data.slug).toBe('product-docs');
  });

  it('中文名称的 slug 回落成 space —— 路由用 uuid,slug 只是给人看的', async () => {
    const { service, prisma } = createService();

    await service.create(ADMIN, { name: '研发中心' });

    expect(prisma.space.create.mock.calls[0]?.[0].data.slug).toBe('space');
  });

  it('自动 slug 撞车时递增序号', async () => {
    const { service, prisma } = createService();
    // deriveUniqueSlug 会先查 'space',被占则查 'space-2'
    prisma.space.findUnique
      .mockResolvedValueOnce({ id: 'taken' })
      .mockResolvedValueOnce(null);

    await service.create(ADMIN, { name: '研发中心' });

    expect(prisma.space.create.mock.calls[0]?.[0].data.slug).toBe('space-2');
  });

  it('显式 slug 已被占用 → VALIDATION_FAILED,且不建空间', async () => {
    const { service, prisma } = createService();
    prisma.space.findUnique.mockResolvedValueOnce({ id: 'taken' });

    await expect(service.create(ADMIN, { name: 'X', slug: 'taken' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.space.create).not.toHaveBeenCalled();
  });

  it('并发下唯一索引兜底:P2002 收敛成 VALIDATION_FAILED 而不是 500', async () => {
    const { service, prisma } = createService();
    prisma.space.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(service.create(ADMIN, { name: 'X', slug: 'race' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

// ======================================================================

describe('SpaceService.listMembers —— 最小可见', () => {
  it('非成员得到 NOT_FOUND,**不是** FORBIDDEN(不暴露空间存在)', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, null);

    await expect(service.listMembers(VIEWER, 'sp-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('空间不存在 → NOT_FOUND', async () => {
    const { service, prisma } = createService();
    prisma.space.findUnique.mockResolvedValueOnce(null);

    await expect(service.listMembers(VIEWER, 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('成员列表:所有者排第一,其余按角色高低,再按加入时间', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'viewer');
    prisma.spaceMember.findMany.mockResolvedValueOnce([
      memberRow('u-viewer', 'viewer', '2026-09-01T00:00:00.000Z'),
      memberRow('u-editor', 'editor', '2026-09-03T00:00:00.000Z'),
      memberRow('u-owner', 'admin', '2026-09-09T00:00:00.000Z'),
      memberRow('u-commenter', 'commenter', '2026-09-02T00:00:00.000Z'),
    ]);

    const result = await service.listMembers(VIEWER, 'sp-1');

    expect(result.members.map((m) => m.userId)).toEqual([
      'u-owner', // 所有者恒第一
      'u-editor',
      'u-commenter',
      'u-viewer',
    ]);
    expect(result.members[0]?.isOwner).toBe(true);
    expect(result.space.memberCount).toBe(4);
  });

  it('角色异常的行被剔除,不会带出非法角色', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'viewer');
    prisma.spaceMember.findMany.mockResolvedValueOnce([
      memberRow('u-bad', 'superuser'),
      memberRow('u-ok', 'editor'),
    ]);

    const result = await service.listMembers(VIEWER, 'sp-1');

    expect(result.members.map((m) => m.userId)).toEqual(['u-ok']);
  });

  it('viewer 也能看成员列表(能力矩阵:page.view 之外的读权限从 viewer 起)', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'viewer');
    prisma.spaceMember.findMany.mockResolvedValueOnce([memberRow('u-viewer', 'viewer')]);

    await expect(service.listMembers(VIEWER, 'sp-1')).resolves.toBeDefined();
  });
});

// ======================================================================

describe('SpaceService.addMember', () => {
  it('viewer 邀请成员 → FORBIDDEN(已知道空间存在,所以不是 NOT_FOUND)', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'viewer');

    await expect(
      service.addMember(VIEWER, 'sp-1', { email: 'a@corp.cn', role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('邮箱已注册 → 直接加入,不建号', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-exist' });
    prisma.spaceMember.findUnique.mockResolvedValueOnce(null);

    const result = await service.addMember(ADMIN, 'sp-1', {
      email: 'exist@corp.cn',
      role: 'editor',
    });

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.spaceMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { spaceId: 'sp-1', userId: 'u-exist', role: 'editor' },
      }),
    );
    expect(result.role).toBe('editor');
  });

  it('邮箱未注册但缺姓名 / 密码 → VALIDATION_FAILED,不建号', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.addMember(ADMIN, 'sp-1', { email: 'new@corp.cn', role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('邮箱未注册且带齐姓名密码 → 建号并加入,且明文密码绝不进 create', async () => {
    const { service, prisma, passwords } = createService();
    stubActorRole(prisma, 'admin');
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.spaceMember.findUnique.mockResolvedValueOnce(null);

    await service.addMember(ADMIN, 'sp-1', {
      email: 'new@corp.cn',
      role: 'commenter',
      name: '新人',
      password: 'plain-text-secret',
    });

    const created = prisma.user.create.mock.calls[0]?.[0];
    expect(created.data.passwordHash).toBe('$2b$12$hashed');
    expect(JSON.stringify(created)).not.toContain('plain-text-secret');
    expect(passwords.hash).toHaveBeenCalledWith('plain-text-secret');
  });

  it('邮箱统一折成小写再入库', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-exist' });
    prisma.spaceMember.findUnique.mockResolvedValueOnce(null);

    await service.addMember(ADMIN, 'sp-1', { email: 'Mixed@Corp.CN', role: 'viewer' });

    expect(prisma.user.findUnique.mock.calls[0]?.[0].where.email).toBe('mixed@corp.cn');
  });

  it('已是成员 → VALIDATION_FAILED', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-exist' });
    prisma.spaceMember.findUnique.mockResolvedValueOnce({ role: 'viewer' });

    await expect(
      service.addMember(ADMIN, 'sp-1', { email: 'exist@corp.cn', role: 'editor' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('并发下复合主键兜底:P2002 收敛成 VALIDATION_FAILED', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-exist' });
    prisma.spaceMember.findUnique.mockResolvedValueOnce(null);
    prisma.spaceMember.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      service.addMember(ADMIN, 'sp-1', { email: 'exist@corp.cn', role: 'editor' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('超管可管理自己不是成员的空间', async () => {
    const { service, prisma } = createService();
    prisma.space.findUnique.mockResolvedValueOnce(SPACE_ROW);
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-exist' });
    prisma.spaceMember.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.addMember(SUPER, 'sp-1', { email: 'exist@corp.cn', role: 'viewer' }),
    ).resolves.toBeDefined();
  });
});

// ======================================================================

describe('SpaceService.updateMemberRole', () => {
  it('所有者不能被降级', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.spaceMember.findUnique.mockResolvedValueOnce({ role: 'admin' });

    await expect(
      service.updateMemberRole(ADMIN, 'sp-1', 'u-owner', 'viewer'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('最后一个管理员不能被降级', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.spaceMember.findUnique.mockResolvedValueOnce({ role: 'admin' });
    prisma.spaceMember.count.mockResolvedValueOnce(1);

    await expect(
      service.updateMemberRole(ADMIN, 'sp-1', 'u-other-admin', 'editor'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.spaceMember.update).not.toHaveBeenCalled();
  });

  it('还有别的管理员时可以降级', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.spaceMember.findUnique.mockResolvedValueOnce({ role: 'admin' });
    prisma.spaceMember.count.mockResolvedValueOnce(2);
    prisma.spaceMember.update.mockResolvedValueOnce(memberRow('u-other', 'editor'));

    const result = await service.updateMemberRole(ADMIN, 'sp-1', 'u-other', 'editor');

    expect(result.role).toBe('editor');
  });

  it('目标不是成员 → NOT_FOUND', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.spaceMember.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.updateMemberRole(ADMIN, 'sp-1', 'u-nobody', 'editor'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('读后写的检查跑在 Serializable 事务里(否则并发能把管理员清空)', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.spaceMember.findUnique.mockResolvedValueOnce({ role: 'viewer' });
    prisma.spaceMember.update.mockResolvedValueOnce(memberRow('u-x', 'editor'));

    await service.updateMemberRole(ADMIN, 'sp-1', 'u-x', 'editor');

    expect(prisma.$transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'Serializable' });
  });

  it('事务写冲突(P2034)→ VERSION_CONFLICT,提示重试而不是 500', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

    await expect(
      service.updateMemberRole(ADMIN, 'sp-1', 'u-x', 'editor'),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

// ======================================================================

describe('SpaceService.removeMember', () => {
  it('所有者不能被移除', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');

    await expect(service.removeMember(ADMIN, 'sp-1', 'u-owner')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.spaceMember.delete).not.toHaveBeenCalled();
  });

  it('最后一个管理员不能被移除', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.spaceMember.findUnique.mockResolvedValueOnce({ role: 'admin' });
    prisma.spaceMember.count.mockResolvedValueOnce(1);

    await expect(service.removeMember(ADMIN, 'sp-1', 'u-other-admin')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.spaceMember.delete).not.toHaveBeenCalled();
  });

  it('普通成员可被移除', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'admin');
    prisma.spaceMember.findUnique.mockResolvedValueOnce({ role: 'viewer' });
    prisma.spaceMember.delete.mockResolvedValueOnce(undefined);

    await service.removeMember(ADMIN, 'sp-1', 'u-someone');

    expect(prisma.spaceMember.delete).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: 'sp-1', userId: 'u-someone' } },
    });
  });

  it('viewer 移除成员 → FORBIDDEN', async () => {
    const { service, prisma } = createService();
    stubActorRole(prisma, 'viewer');

    await expect(service.removeMember(VIEWER, 'sp-1', 'u-someone')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
