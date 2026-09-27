/**
 * 批量移动的校验测试(v2.14)。
 *
 * ## 为什么先测校验,不测"移成功了"
 *
 * 移动成功与否,真跑一次接口就看得出来;而**该拒的没拒**看不出来 ——
 * 它只表现为某棵树的形状变得很怪,而且要过一阵子才有人发现
 * (权限判定也走物化路径,所以路径错了会连带把权限带偏)。
 *
 * 三条该拒的:
 *   1. 把节点移到它自己或它的子孙下(**成环** —— 树会断)
 *   2. 批量里互为祖先(结果取决于执行顺序,不可预测)
 *   3. 超过数量上限
 */
import { describe, expect, it, vi } from 'vitest';

import type { Actor } from '@knowledgecool/shared';

import { NodeService } from './node.service.js';

const ACTOR: Actor = { id: 'u-a', isSuperAdmin: false };

/** 造一个只有校验需要的那几个字段的节点行。 */
function row(id: string, materializedPath: string, title: string, depth = 0) {
  return {
    id,
    parentId: null,
    ownerId: 'u-a',
    title,
    depth,
    materializedPath,
    version: 1,
    visibility: 'public',
    createdBy: 'u-a',
  };
}

/**
 * 技术部 ─ 后端组 ─ 接口规范;另有市场部。
 * 传进来的 `world` 决定 requireEdit / pluck 能查到什么。
 */
function createFixture() {
  const world = new Map([
    ['dept-tech', row('dept-tech', '/dept-tech', '技术部')],
    ['grp-be', row('grp-be', '/dept-tech/grp-be', '后端组', 1)],
    ['doc-api', row('doc-api', '/dept-tech/grp-be/doc-api', '接口规范', 2)],
    // grp-be 的**真兄弟** —— 「两个平级节点一起移动」那条用例需要它。
    // 第一版我拿 grp-be 和 doc-api 当"两兄弟",而它们其实是父子,
    // 于是被「互为祖先」那条规则正确地拒掉了 —— 是**用例写错了**,不是实现错了。
    ['grp-crm', row('grp-crm', '/dept-tech/grp-crm', 'CRM 项目', 1)],
    ['dept-mkt', row('dept-mkt', '/dept-mkt', '市场部')],
  ]);

  const permissions = {
    requireEdit: vi.fn(async (_actor: Actor, nodeId: string) => {
      const found = world.get(nodeId);
      if (found === undefined) throw new Error('NOT_FOUND:' + nodeId);
      return { row: found, chain: {}, nodeId, canRead: true, canEdit: true, canManage: true };
    }),
    invalidateByNode: vi.fn(async () => undefined),
  };

  const tx = {
    node: { update: vi.fn(async () => undefined), updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
  };

  const prisma = {
    $transaction: vi.fn(async (work: (t: unknown) => unknown) => work(tx)),
    node: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => world.get(where.id) ?? null) },
    auditLog: { create: vi.fn(async () => undefined) },
  };

  const service = new NodeService(prisma as never, permissions as never);
  return { service, prisma, tx, permissions };
}

describe('NodeService.bulkMove —— 该拒的必须拒', () => {
  it('★ 把节点移到它自己的子孙下 → 拒(成环,树会断)', async () => {
    // 少了这一条,物化路径会变成 /dept-tech/grp-be/.../dept-tech —— 之后前缀查询
    // 既查不到它的祖先,也会把它自己算成自己的后代。
    const { service } = createFixture();
    await expect(
      service.bulkMove(ACTOR, { nodeIds: ['dept-tech'], newParentId: 'doc-api' }),
    ).rejects.toThrow(/不能移动到它自己或它的子节点下/);
  });

  it('★ 把节点移到它自己下面 → 拒', async () => {
    const { service } = createFixture();
    await expect(
      service.bulkMove(ACTOR, { nodeIds: ['grp-be'], newParentId: 'grp-be' }),
    ).rejects.toThrow(/不能移动到它自己或它的子节点下/);
  });

  it('★★ 批量里互为祖先 → 拒(结果会取决于执行顺序)', async () => {
    // 选了 A 又选它里面的 B:先移 A 会把 B 一起带走,再移 B 又把它拽出来 ——
    // 最终都在目标下,但"我明明只选了两个,怎么动了三个"这种疑问必然出现。
    const { service } = createFixture();
    await expect(
      service.bulkMove(ACTOR, { nodeIds: ['dept-tech', 'doc-api'], newParentId: 'dept-mkt' }),
    ).rejects.toThrow(/请只选最外层的那几个/);
  });

  it('★ 校验失败时**一个都不该被移动**(不能部分成功)', async () => {
    // 这条比上面两条更要紧:校验漏在事务里的话,前几个已经移走了,
    // 用户在界面上看到的是一个**他没预期过的中间状态**。
    const { service, tx } = createFixture();
    await expect(
      service.bulkMove(ACTOR, { nodeIds: ['grp-be', 'doc-api'], newParentId: 'dept-mkt' }),
    ).rejects.toThrow();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.node.update).not.toHaveBeenCalled();
  });

  it('空选择 → 拒', async () => {
    const { service } = createFixture();
    await expect(service.bulkMove(ACTOR, { nodeIds: [], newParentId: 'dept-mkt' })).rejects.toThrow(
      /请先选择要移动的节点/,
    );
  });

  it('超过上限 → 拒(而不是静默只移前 50 个)', async () => {
    const { service } = createFixture();
    const tooMany = Array.from({ length: 51 }, (_, index) => 'id-' + String(index));
    await expect(
      service.bulkMove(ACTOR, { nodeIds: tooMany, newParentId: 'dept-mkt' }),
    ).rejects.toThrow(/一次最多移动/);
  });

  it('重复的 id 会被去重(不会把同一个节点移两遍)', async () => {
    const { service, tx } = createFixture();
    const result = await service.bulkMove(ACTOR, {
      nodeIds: ['grp-be', 'grp-be'],
      newParentId: 'dept-mkt',
    });
    expect(result.moved).toBe(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('正常的两兄弟一起移动 → 允许,两个节点各重写一次子树路径', async () => {
    const { service, tx } = createFixture();
    const result = await service.bulkMove(ACTOR, {
      nodeIds: ['grp-be', 'grp-crm'],
      newParentId: 'dept-mkt',
    });
    expect(result.moved).toBe(2);
    // 每个节点一次:grp-be 那次会连它下面的 doc-api 一起改(靠 LIKE 前缀),
    // 所以"移动两个节点"是两次语句,而不是三次。
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
});
