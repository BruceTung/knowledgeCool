/**
 * CommentService 的授权与展示测试(v2.14)—— 此前这个服务**一个测试都没有**。
 *
 * ## 为什么挑 comment 先测
 *
 * 评论有两条容易写错的规则,而写错了都不会报错:
 *
 *   1. **`canEdit` 与 `canDelete` 是两件事。** 所有者能**删**别人的评论(版务),
 *      但**不能改**(篡改他人言论)。代码注释里写着这一点曾经出过错 ——
 *      "两个按钮共用一个标志,结果所有者看得到「编辑」、点了却 403"。
 *   2. **删除的门槛是 `canManage`,不是 `canEdit`。** 被授权编辑的人能改文档,
 *      但不该能删别人的评论。
 */
import { describe, expect, it, vi } from 'vitest';

import type { Actor } from '@knowledgecool/shared';

import { CommentService } from './comment.service.js';

const AUTHOR: Actor = { id: 'u-author', isSuperAdmin: false };
const OWNER: Actor = { id: 'u-owner', isSuperAdmin: false };
const STRANGER: Actor = { id: 'u-stranger', isSuperAdmin: false };

function commentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c-1',
    nodeId: 'n-1',
    parentId: null,
    body: '这是一条评论',
    createdAt: new Date('2026-09-27T00:00:00Z'),
    updatedAt: new Date('2026-09-27T00:00:00Z'),
    userId: 'u-author',
    user: { id: 'u-author', name: '作者', avatarColor: '#888', status: 'active' },
    ...overrides,
  };
}

/** @param canManage 调用方在**这个节点上**能否管(所有者链) */
function createFixture(canManage: boolean, rows: unknown[] = [commentRow()]) {
  const prisma = {
    comment: {
      findMany: vi.fn(async () => rows),
      findUnique: vi.fn(async () => ({ id: 'c-1', nodeId: 'n-1', userId: 'u-author' })),
      delete: vi.fn(async () => undefined),
      update: vi.fn(async () => commentRow()),
      count: vi.fn(async () => 0),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  };
  const permissions = {
    requireRead: vi.fn(async () => ({ canRead: true })),
    access: vi.fn(async () => ({ canRead: true, canEdit: true, canManage })),
  };
  return { service: new CommentService(prisma as never, permissions as never), prisma, permissions };
}

describe('CommentService.list —— 展示用的两个标志', () => {
  it('作者对自己的评论:可改也可删', async () => {
    const { service } = createFixture(false);
    const result = await service.list(AUTHOR, 'n-1');
    const first = result.threads[0];
    expect(first?.canEdit).toBe(true);
    expect(first?.canDelete).toBe(true);
  });

  it('★★ 所有者能**删**别人的评论,但**不能改**', async () => {
    // 这是这个文件里最要紧的一条:删是版务(删掉不当言论),
    // 改是篡改他人言论。两者必须分开。
    // 曾经共用一个标志,表现是"所有者看得到「编辑」、点了却 403"。
    const { service } = createFixture(true);
    const result = await service.list(OWNER, 'n-1');
    const first = result.threads[0];
    expect(first?.canDelete).toBe(true);
    expect(first?.canEdit).toBe(false);
  });

  it('无关的人:两个都不能', async () => {
    const { service } = createFixture(false);
    const result = await service.list(STRANGER, 'n-1');
    const first = result.threads[0];
    expect(first?.canEdit).toBe(false);
    expect(first?.canDelete).toBe(false);
  });

  it('读评论要先过读判定(受限节点不该漏出评论)', async () => {
    const { service, permissions } = createFixture(false);
    await service.list(STRANGER, 'n-1');
    expect(permissions.requireRead).toHaveBeenCalledWith(STRANGER, 'n-1');
  });

  it('已离职作者被标出来(界面要在名字旁显示「已离职」)', async () => {
    const { service } = createFixture(false, [
      commentRow({ user: { id: 'u-author', name: '作者', avatarColor: '#888', status: 'departed' } }),
    ]);
    const result = await service.list(AUTHOR, 'n-1');
    expect(result.threads[0]?.author.departed).toBe(true);
  });
});

describe('CommentService.remove —— 谁能删', () => {
  it('作者能删自己的', async () => {
    const { service, prisma } = createFixture(false);
    await service.remove(AUTHOR, 'c-1');
    expect(prisma.comment.delete).toHaveBeenCalled();
  });

  it('★ 所有者能删别人的(canManage)', async () => {
    const { service, prisma } = createFixture(true);
    await service.remove(OWNER, 'c-1');
    expect(prisma.comment.delete).toHaveBeenCalled();
  });

  it('★★ 不能管的人删不了别人的 —— 而且报错要说清"只能删自己的"', async () => {
    const { service, prisma } = createFixture(false);
    await expect(service.remove(STRANGER, 'c-1')).rejects.toThrow(/只能删除自己的评论/);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });

  it('评论不存在 → 404', async () => {
    const { service, prisma } = createFixture(false);
    prisma.comment.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.remove(AUTHOR, 'c-1')).rejects.toThrow();
  });
});

describe('CommentService —— 读不到就别想写', () => {
  it('发评论也要先过读判定(受限节点不能靠评论接口探到它的存在)', async () => {
    const { service, permissions } = createFixture(false);
    permissions.requireRead.mockRejectedValueOnce(new Error('NOT_FOUND') as never);
    await expect(service.create(STRANGER, 'n-1', { body: 'hi' })).rejects.toThrow();
  });
});
