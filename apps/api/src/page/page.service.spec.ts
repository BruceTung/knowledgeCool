/**
 * 页面树服务测试。
 *
 * 重点在**几条错了不会立刻报错的规则**(DESIGN.md §12 与 §8.1):
 *   - `move` 必须递归重建整棵子树的路径与深度,只改自己会让所有子孙指向旧位置
 *   - 防环:不能把页面移到自己或自己的子孙下
 *   - 软删除要**整棵子树一起**标记,不能只标自己
 *   - 恢复时原父已不在树上 → 挂回空间根下
 *   - 彻底删除必须从叶子往根删(parent_id 是 onDelete: Restrict)
 *
 * 这些都是「当下没有任何报错、几周后才炸」的类型,所以每一条都有用例。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PageService,
  ancestorIdsOf,
  pathOfChild,
  pathOfRoot,
  segmentsOf,
  subtreePrefix,
} from './page.service.js';

const SPACE = { id: 'sp-1', name: '研发中心', slug: 'dev', letter: '研', color: 'blue', ownerId: 'u-owner' };
const OPERATOR = { id: 'u-admin', isSuperAdmin: false };

function pageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    spaceId: 'sp-1',
    parentId: null,
    title: '页面',
    position: 0,
    materializedPath: '/p-1',
    depth: 0,
    status: 'published',
    version: 1,
    deletedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

function createService() {
  const prisma = {
    page: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // 标记模板调用会被记成 (strings, ...values)
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

  prisma.page.findUnique.mockResolvedValue(pageRow());
  prisma.page.findMany.mockResolvedValue([]);
  prisma.page.findFirst.mockResolvedValue(null);
  prisma.page.updateMany.mockResolvedValue({ count: 1 });
  prisma.page.deleteMany.mockResolvedValue({ count: 1 });
  prisma.page.update.mockResolvedValue(pageRow());
  prisma.page.create.mockImplementation(async (args: { data: Record<string, unknown> }) =>
    pageRow(args.data),
  );

  const spaces = { requireCapability: vi.fn() };
  spaces.requireCapability.mockResolvedValue({ role: 'admin', space: SPACE });

  /**
   * 权限服务的替身。
   *
   * 它刻意**委托给同一份 prisma 桩**去取页面行 —— 这样各用例里
   * `findUnique.mockResolvedValueOnce` 写下的调用序列仍然对得上,
   * 不必为每个用例重写"页面从哪来"。
   *
   * 这里的 `role: 'admin'` 表示"鉴权已通过",**不是**在测权限判定本身 ——
   * 权限判定有自己的单测(permission.service.spec.ts)。
   */
  const permissions = {
    requireCapability: vi.fn(
      async (
        _operator: unknown,
        pageId: string,
        _capability: string,
        options?: { allowDeleted?: boolean },
      ) => {
        const page = await prisma.page.findUnique({ where: { id: pageId } });
        if (page === null) throw new Error('not found');
        if (page.deletedAt !== null && options?.allowDeleted !== true) {
          throw Object.assign(new Error('已删除'), { code: 'NOT_FOUND' });
        }
        return { role: 'admin', spaceRole: 'admin', viaSuperAdmin: false, page };
      },
    ),
    requireCreateIn: vi.fn(async (_operator: unknown, spaceId: string, parentId: string | null) => {
      if (parentId === null) return null;
      const page = await prisma.page.findUnique({ where: { id: parentId } });
      if (page === null || page.deletedAt !== null) {
        throw Object.assign(new Error('已删除'), { code: 'NOT_FOUND' });
      }
      if (page.spaceId !== spaceId) {
        throw Object.assign(new Error('跨空间'), { code: 'VALIDATION_FAILED' });
      }
      return page;
    }),
    visibility: vi.fn(async () => ({
      spaceRole: 'admin',
      unrestricted: true,
      allowed: new Set<string>(),
    })),
  };

  const service = new PageService(prisma as never, spaces as never, permissions as never);
  return { service, prisma, spaces, permissions };
}

/** 取出最近一次 $executeRaw 的 SQL 文本与插值。 */
function lastRaw(prisma: ReturnType<typeof createService>['prisma']) {
  const call = prisma.$executeRaw.mock.calls.at(-1);
  if (call === undefined) return null;
  const strings = call[0] as unknown as string[];
  return { sql: strings.join('?'), values: call.slice(1) as unknown[] };
}

// ======================================================================

describe('路径算术(纯函数)', () => {
  it('根路径是 /<id>,子路径是父路径 + /<id>', () => {
    expect(pathOfRoot('a')).toBe('/a');
    expect(pathOfChild('/a', 'b')).toBe('/a/b');
    expect(pathOfChild('/a/b', 'c')).toBe('/a/b/c');
  });

  it('子树前缀末尾必须带斜杠 —— 少了它会误伤 /ab 这类兄弟', () => {
    expect(subtreePrefix('/a')).toBe('/a/');
    // 反例说明为什么不能省:'/a' + '%' 会匹配到 '/ab'
    expect('/ab'.startsWith('/a')).toBe(true);
    expect('/ab'.startsWith(subtreePrefix('/a'))).toBe(false);
  });

  it('段数:根 1 段,深度 = 段数 − 1', () => {
    expect(segmentsOf('/a')).toBe(1);
    expect(segmentsOf('/a/b')).toBe(2);
    expect(segmentsOf('/a/b/c')).toBe(3);
    expect(segmentsOf('/a')).toBe(1);
  });

  it('祖先 id 从路径切出来,不含自身', () => {
    expect(ancestorIdsOf('/a/b/c')).toEqual(['a', 'b']);
    expect(ancestorIdsOf('/a')).toEqual([]);
  });
});

// ======================================================================

describe('PageService.create', () => {
  it('建在根下:路径是 /<id>,深度 0', async () => {
    const { service, prisma } = createService();

    await service.create(OPERATOR, { spaceId: 'sp-1', parentId: null, title: '产品文档' });

    const data = prisma.page.create.mock.calls[0]?.[0].data;
    expect(data.materializedPath).toBe(`/${String(data.id)}`);
    expect(data.depth).toBe(0);
    expect(data.position).toBe(0);
  });

  it('建在父下:路径接在父路径后,深度 = 父深度 + 1', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(
      pageRow({ id: 'p-parent', materializedPath: '/p-parent', depth: 0 }),
    );

    await service.create(OPERATOR, { spaceId: 'sp-1', parentId: 'p-parent', title: '子页' });

    const data = prisma.page.create.mock.calls[0]?.[0].data;
    expect(data.materializedPath).toBe(`/p-parent/${String(data.id)}`);
    expect(data.depth).toBe(1);
  });

  it('父页面不在同一空间 → VALIDATION_FAILED', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(pageRow({ spaceId: 'sp-OTHER' }));

    await expect(
      service.create(OPERATOR, { spaceId: 'sp-1', parentId: 'p-parent' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('父页面在回收站里 → NOT_FOUND(已删除一律视同不存在)', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(pageRow({ deletedAt: new Date() }));

    await expect(
      service.create(OPERATOR, { spaceId: 'sp-1', parentId: 'p-parent' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('空标题落回「未命名页面」,不出现看不见名字的页面', async () => {
    const { service, prisma } = createService();

    await service.create(OPERATOR, { spaceId: 'sp-1', parentId: null, title: '   ' });

    expect(prisma.page.create.mock.calls[0]?.[0].data.title).toBe('未命名页面');
  });

  it('需要 page.create 能力 —— 建在根下时查空间角色', async () => {
    const { service, permissions } = createService();

    await service.create(OPERATOR, { spaceId: 'sp-1', parentId: null });

    expect(permissions.requireCreateIn).toHaveBeenCalledWith(OPERATOR, 'sp-1', null);
  });
});

// ======================================================================

describe('PageService.update —— 乐观锁', () => {
  it('version 不匹配 → VERSION_CONFLICT,而不是静默覆盖', async () => {
    const { service, prisma } = createService();
    prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.update(OPERATOR, 'p-1', { title: '新标题', version: 1 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('检查与写入压在同一条语句:where 里带 version', async () => {
    const { service, prisma } = createService();

    await service.update(OPERATOR, 'p-1', { title: '新标题', version: 3 });

    const call = prisma.page.updateMany.mock.calls[0]?.[0];
    expect(call.where).toMatchObject({ id: 'p-1', version: 3 });
    expect(call.data.version).toEqual({ increment: 1 });
  });
});

// ======================================================================

describe('PageService.move —— M3 的核心', () => {
  it('⚠️ 递归重建整棵子树的路径与深度(一条 UPDATE 完成)', async () => {
    const { service, prisma } = createService();
    // 被移动的是 /p-1;目标是根下的另一个节点 /p-2
    prisma.page.findUnique
      .mockResolvedValueOnce(pageRow({ id: 'p-1', materializedPath: '/p-1', depth: 0 }))
      .mockResolvedValueOnce(pageRow({ id: 'p-2', materializedPath: '/p-2', depth: 0 }));

    await service.move(OPERATOR, 'p-1', { newParentId: 'p-2', newPosition: 0, version: 1 });

    const raw = lastRaw(prisma);
    expect(raw).not.toBeNull();
    // 新路径插值
    expect(raw?.values[0]).toBe('/p-2/p-1');
    // SQL 里必须出现:按前缀圈定整棵子树
    expect(raw?.sql).toContain('materialized_path LIKE');
    // ⚠️ 必须是 substr 的定位形式,不能是 `substring(x from n)` ——
    // 后者在参数类型为 unknown 时会被 PostgreSQL 解析成 POSIX 正则并静默返回 NULL
    expect(raw?.sql).toContain('substr(materialized_path,');
    expect(raw?.sql).not.toContain('substring(materialized_path from');
    // 前缀要带斜杠,否则会误伤 /p-1x 这类兄弟
    expect(raw?.values).toContain('/p-1/');
  });

  it('⚠️ 深度增量按新旧父节点层级算', async () => {
    const { service, prisma } = createService();
    // 把一个根页面(深度 0)移到两层的父下,深度应变 2
    prisma.page.findUnique
      .mockResolvedValueOnce(pageRow({ id: 'p-1', materializedPath: '/p-1', depth: 0 }))
      .mockResolvedValueOnce(pageRow({ id: 'x', materializedPath: '/a/x', depth: 1 }));

    await service.move(OPERATOR, 'p-1', { newParentId: 'x', version: 1 });

    // values: [newPath, oldPrefix.length+1, depthDelta, spaceId, pageId, subtreePrefix]
    expect(lastRaw(prisma)?.values).toContain(2);
  });

  it('移到空间根下:新路径是 /<id>,深度归零', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(
      pageRow({ id: 'p-1', materializedPath: '/a/b/p-1', depth: 2 }),
    );

    await service.move(OPERATOR, 'p-1', { newParentId: null, version: 1 });

    const raw = lastRaw(prisma);
    expect(raw?.values[0]).toBe('/p-1');
    // 深度增量 = 0 - 2 = -2
    expect(raw?.values).toContain(-2);
  });

  it('防环:不能移到自己下', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(pageRow({ id: 'p-1' }));

    await expect(
      service.move(OPERATOR, 'p-1', { newParentId: 'p-1', version: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('防环:不能移到自己子孙下(用路径前缀判定)', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique
      .mockResolvedValueOnce(pageRow({ id: 'p-1', materializedPath: '/p-1', depth: 0 }))
      // 目标父的路径以「被移动节点路径 + /」开头 → 它是子孙
      .mockResolvedValueOnce(pageRow({ id: 'p-child', materializedPath: '/p-1/p-child', depth: 1 }));

    await expect(
      service.move(OPERATOR, 'p-1', { newParentId: 'p-child', version: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('带斜杠的前缀判定不会误伤同名兄弟: /p-1 移到 /p-10 下是合法的', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique
      .mockResolvedValueOnce(pageRow({ id: 'p-1', materializedPath: '/p-1', depth: 0 }))
      .mockResolvedValueOnce(pageRow({ id: 'p-10', materializedPath: '/p-10', depth: 0 }));

    await expect(
      service.move(OPERATOR, 'p-1', { newParentId: 'p-10', version: 1 }),
    ).resolves.toBeDefined();
  });

  it('不能跨空间移动', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique
      .mockResolvedValueOnce(pageRow({ id: 'p-1' }))
      .mockResolvedValueOnce(pageRow({ id: 'x', spaceId: 'sp-OTHER' }));

    await expect(
      service.move(OPERATOR, 'p-1', { newParentId: 'x', version: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('version 不匹配 → VERSION_CONFLICT,且不动路径', async () => {
    const { service, prisma } = createService();
    prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.move(OPERATOR, 'p-1', { newParentId: null, version: 99 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('读后写的检查跑在 Serializable 事务里', async () => {
    const { service, prisma } = createService();

    await service.move(OPERATOR, 'p-1', { newParentId: null, version: 1 });

    expect(prisma.$transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'Serializable' });
  });
});

// ======================================================================

describe('PageService.remove —— 软删除级联', () => {
  it('⚠️ 整棵子树一起标记,而不是只标自己', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(
      pageRow({ id: 'p-1', materializedPath: '/p-1' }),
    );

    await service.remove(OPERATOR, 'p-1');

    const call = prisma.page.updateMany.mock.calls[0]?.[0];
    expect(call.where.OR).toEqual([
      { id: 'p-1' },
      { materializedPath: { startsWith: '/p-1/' } },
    ]);
  });

  it('⚠️ 不重复盖章:已经删过的子孙不再被更新一次', async () => {
    const { service, prisma } = createService();

    await service.remove(OPERATOR, 'p-1');

    // 少了这个条件,子树里早先单独删掉的页面会被盖上新的时间戳,
    // removedCount 也会虚高(界面显示「删了 N 个」而实际只动了 1 个)
    expect(prisma.page.updateMany.mock.calls[0]?.[0].where.deletedAt).toBeNull();
  });

  it('整批用同一个时间戳(恢复时靠它识别「同一批删的」)', async () => {
    const { service, prisma } = createService();

    await service.remove(OPERATOR, 'p-1');

    const call = prisma.page.updateMany.mock.calls[0]?.[0];
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    expect(call.data.deletedBy).toBe('u-admin');
  });

  it('返回被影响的条数,让前端能提示「共删除 N 个页面」', async () => {
    const { service, prisma } = createService();
    prisma.page.updateMany.mockResolvedValueOnce({ count: 7 });

    await expect(service.remove(OPERATOR, 'p-1')).resolves.toEqual({ removedCount: 7 });
  });

  it('已在回收站里的页面不能重复删除 → NOT_FOUND', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(pageRow({ deletedAt: new Date() }));

    await expect(service.remove(OPERATOR, 'p-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ======================================================================

describe('PageService.restore', () => {
  it('不在回收站里 → VALIDATION_FAILED', async () => {
    const { service } = createService();

    await expect(service.restore(OPERATOR, 'p-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('原父还活着 → 原地恢复,不重建路径', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique
      .mockResolvedValueOnce(pageRow({ id: 'p-1', parentId: 'p-parent', deletedAt: new Date() }))
      .mockResolvedValueOnce({ deletedAt: null });

    await service.restore(OPERATOR, 'p-1');

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.page.updateMany).toHaveBeenCalled();
  });

  it('⚠️ 原父也在回收站里 → 挂回空间根下(DESIGN §8.2)', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique
      .mockResolvedValueOnce(
        pageRow({
          id: 'p-1',
          parentId: 'p-parent',
          materializedPath: '/p-parent/p-1',
          depth: 1,
          deletedAt: new Date(),
        }),
      )
      .mockResolvedValueOnce({ deletedAt: new Date() });

    await service.restore(OPERATOR, 'p-1');

    const raw = lastRaw(prisma);
    expect(raw?.values[0]).toBe('/p-1');
    // 深度增量 = -1
    expect(raw?.values).toContain(-1);
    // parent_id 只在子树根上置空
    expect(raw?.sql).toContain('CASE WHEN id =');
  });

  it('原父已被彻底删除 → 同样挂回根下', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique
      .mockResolvedValueOnce(pageRow({ id: 'p-1', parentId: 'gone', deletedAt: new Date() }))
      .mockResolvedValueOnce(null);

    await service.restore(OPERATOR, 'p-1');

    expect(prisma.$executeRaw).toHaveBeenCalled();
  });
});

// ======================================================================

describe('PageService.trash', () => {
  it('只列被删子树的根,并给出子孙数', async () => {
    const { service, prisma } = createService();
    prisma.page.findMany.mockResolvedValueOnce([
      {
        id: 'p-1',
        parentId: null,
        title: '父',
        materializedPath: '/p-1',
        deletedAt: new Date('2026-09-10T00:00:00Z'),
        deletedBy: 'u-admin',
      },
      {
        id: 'c-1',
        parentId: 'p-1',
        title: '子',
        materializedPath: '/p-1/c-1',
        deletedAt: new Date('2026-09-10T00:00:00Z'),
        deletedBy: 'u-admin',
      },
      {
        id: 'c-2',
        parentId: 'c-1',
        title: '孙',
        materializedPath: '/p-1/c-1/c-2',
        deletedAt: new Date('2026-09-10T00:00:00Z'),
        deletedBy: 'u-admin',
      },
    ]);

    const items = await service.trash(OPERATOR, 'sp-1');

    // 子与孙不单独出现 —— 恢复是整棵子树一起回来的
    expect(items.map((i) => i.id)).toEqual(['p-1']);
    expect(items[0]?.descendantCount).toBe(2);
  });

  it('兄弟子树互不干扰', async () => {
    const { service, prisma } = createService();
    prisma.page.findMany.mockResolvedValueOnce([
      {
        id: 'a',
        parentId: null,
        title: 'A',
        materializedPath: '/a',
        deletedAt: new Date(),
        deletedBy: null,
      },
      {
        id: 'ab',
        parentId: null,
        title: 'AB',
        materializedPath: '/ab',
        deletedAt: new Date(),
        deletedBy: null,
      },
      {
        id: 'ab-child',
        parentId: 'ab',
        title: 'AB 子',
        materializedPath: '/ab/child',
        deletedAt: new Date(),
        deletedBy: null,
      },
    ]);

    const items = await service.trash(OPERATOR, 'sp-1');

    expect(items.map((i) => i.id)).toEqual(['a', 'ab']);
    // /ab 的子孙不该被算进 /a 的子孙数(前缀斜杠的作用)
    expect(items.find((i) => i.id === 'a')?.descendantCount).toBe(0);
    expect(items.find((i) => i.id === 'ab')?.descendantCount).toBe(1);
  });
});

// ======================================================================

describe('PageService.purge', () => {
  it('只能彻底删除回收站里的页面 —— 强制两步,防手滑', async () => {
    const { service } = createService();

    await expect(service.purge(OPERATOR, 'p-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('需要 page.purge(admin 起),比软删除的门槛高', async () => {
    const { service, permissions, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(pageRow({ deletedAt: new Date() }));

    await service.purge(OPERATOR, 'p-1');

    // 必须显式放行已删除的行,否则回收站里的页面永远取不到
    expect(permissions.requireCapability).toHaveBeenCalledWith(OPERATOR, 'p-1', 'page.purge', {
      allowDeleted: true,
    });
  });

  it('⚠️ 从叶子往根删 —— parent_id 是 onDelete: Restrict,先删父会撞外键', async () => {
    const { service, prisma } = createService();
    prisma.page.findUnique.mockResolvedValueOnce(
      pageRow({ id: 'p-1', materializedPath: '/p-1', deletedAt: new Date() }),
    );

    const order: string[][] = [];
    prisma.page.findMany
      // 第一次:三层都在。**刻意打乱顺序** —— 服务应当自己找最深的一层,
      // 而不是依赖数据库的返回顺序(夹具能证明这一点)
      .mockResolvedValueOnce([
        { id: 'c-1', depth: 1 },
        { id: 'p-1', depth: 0 },
        { id: 'g-1', depth: 2 },
      ])
      // 第二次:最深那层已删
      .mockResolvedValueOnce([
        { id: 'p-1', depth: 0 },
        { id: 'c-1', depth: 1 },
      ])
      // 第三次:只剩根
      .mockResolvedValueOnce([{ id: 'p-1', depth: 0 }])
      // 第四次:空了
      .mockResolvedValueOnce([]);
    prisma.page.deleteMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => {
      order.push(args.where.id.in);
      return { count: args.where.id.in.length };
    });

    await service.purge(OPERATOR, 'p-1');

    // 由深到浅:先孙、再子、最后父
    expect(order).toEqual([['g-1'], ['c-1'], ['p-1']]);
  });
});
