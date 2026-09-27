/**
 * AuditService 的测试(v2.14)—— 此前零测试。
 *
 * 挑三条来钉,都是"错了不会报错"的:
 *
 *   1. **游标校验**。原实现把查询串原样拼进 `::bigint`,于是 `?cursor=abc`
 *      让 PostgreSQL 抛 22P02,再被全局过滤器兜成 **500 INTERNAL_ERROR** ——
 *      一个纯客户端的参数错误显示成"服务器内部错误",任何登录用户都能触发,
 *      还在日志里留下假的故障记录。
 *   2. **可见范围的前缀不能少末尾斜杠**,否则 `/p-1` 会被当成 `/p-10` 的祖先 ——
 *      也就是**一号部门的部长能看到十号部门的审计记录**。
 *   3. **导出必须与列表共用同一份范围**。分叉的表现是"页面上看不到、
 *      导出文件里全有",一次越权读取,而没有任何地方会报错。
 */
import { describe, expect, it, vi } from 'vitest';

import type { Actor } from '@knowledgecool/shared';

import { AuditService, normalizeCursor } from './audit.service.js';

const SUPER: Actor = { id: 'u-super', isSuperAdmin: true };
const MINISTER: Actor = { id: 'u-minister', isSuperAdmin: false };

describe('normalizeCursor —— 游标是输入边界,必须先校验', () => {
  it('undefined / 空串 / 空白 → null(第一页)', () => {
    expect(normalizeCursor(undefined)).toBeNull();
    expect(normalizeCursor('')).toBeNull();
    expect(normalizeCursor('   ')).toBeNull();
  });

  it('纯数字串原样返回(两端空白会去掉)', () => {
    expect(normalizeCursor('123')).toBe('123');
    expect(normalizeCursor(' 456 ')).toBe('456');
  });

  it('★ 非数字 → 400,而不是让它进 SQL 变成 500', () => {
    // 这条断言的就是上面注释里那个真实缺陷。
    for (const bad of ['abc', '12a', '-1', '1.5', '1 OR 1=1']) {
      expect(() => normalizeCursor(bad)).toThrow(/游标不合法/);
    }
  });

  it('★ 超过 19 位 → 400(会溢出 signed 64-bit)', () => {
    expect(normalizeCursor('1111111111111111111')).toBe('1111111111111111111');
    expect(() => normalizeCursor('11111111111111111111')).toThrow(/游标不合法/);
  });

  it('★ 只接受纯数字,不接受十六进制与科学计数法', () => {
    expect(() => normalizeCursor('0x10')).toThrow();
    expect(() => normalizeCursor('1e5')).toThrow();
  });
});

/** 造一个只记调用的 prisma 桩,并记录每次查询的 where。 */
function createFixture(ownedPaths: string[], scopedRows: { id: string }[]) {
  const wheres: unknown[] = [];
  const prisma = {
    node: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        wheres.push(args.where);
        // 第一次是查"我拥有的节点",第二次是查它们的后代
        const hasOwnerFilter = JSON.stringify(args.where).includes('u-minister');
        return hasOwnerFilter
          ? ownedPaths.map((path) => ({ materializedPath: path, id: 'x' }))
          : scopedRows;
      }),
    },
    $queryRaw: vi.fn(async () => []),
  };
  return { service: new AuditService(prisma as never), prisma, wheres };
}

describe('AuditService —— 可见范围', () => {
  it('★ 超管的范围是空数组(他走 isSuperAdmin 分支直接看全部,不必全表扫)', async () => {
    const { service, prisma } = createFixture([], []);
    const logs = await service.list(SUPER, {});
    expect(logs.items).toEqual([]);
    // 超管**一次节点查询都不该发**
    expect(prisma.node.findMany).not.toHaveBeenCalled();
  });

  it('★★ 后代查询的前缀必须带末尾斜杠(否则 /p-1 会匹配到 /p-10)', async () => {
    // 少了斜杠,一号部门的部长就能看到十号部门的审计记录。
    const { service, wheres } = createFixture(['/p-1'], []);
    await service.list(MINISTER, {});
    const scoped = JSON.stringify(wheres.at(-1));
    expect(scoped).toContain('/p-1/');
  });

  it('拥有的节点是它自己 + 全部后代(两条 OR)', async () => {
    const { service, wheres } = createFixture(['/dept-a'], []);
    await service.list(MINISTER, {});
    const scoped = JSON.stringify(wheres.at(-1));
    expect(scoped).toContain('/dept-a');
    expect(scoped).toContain('startsWith');
  });
});

describe('AuditService.exportCsv —— 与列表同一个范围', () => {
  it('★ 导出也要查一遍范围 —— 不能因为"它只是导出"就跳过', async () => {
    const { service, prisma } = createFixture(['/p-1'], []);
    await service.exportCsv(MINISTER, {});
    expect(prisma.node.findMany).toHaveBeenCalled();
  });

  it('★ 导出的 CSV 带表头与 BOM(空结果也要是一份合法文件)', async () => {
    const { service } = createFixture([], []);
    const result = await service.exportCsv(SUPER, {});
    expect(result.csv.startsWith(String.fromCharCode(0xfeff))).toBe(true);
    expect(result.csv).toContain('时间');
    expect(result.exported).toBe(0);
    expect(result.capped).toBe(false);
  });
});
