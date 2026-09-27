/**
 * 保密过滤的纯函数测试(v2.14)。
 *
 * ## 为什么这一组最要紧
 *
 * 这是全系统里**判定错了最不容易被发现**的地方:漏判的表现不是报错,而是
 * 「某一层的标题被不该看见的人看见了」—— 界面、接口、日志全都正常。
 * 而且保密这件事**没法靠人工点一遍来确认**:你只能验证「该看见的人看得见」,
 * 很难确认「不该看见的人确实看不见」(那需要以每个身份走一遍全站)。
 *
 * 每条用例的注释里都写清「写错会怎样」。
 */
import { describe, expect, it } from 'vitest';

import type { NodeAccessLists } from '../src/permission.js';
import { readableNodeIds, type ReadableNode } from '../src/visibility.js';

function node(
  id: string,
  parentId: string | null,
  ownerId: string,
  visibility: string = 'public',
): ReadableNode {
  return { id, parentId, ownerId, visibility };
}

const NO_LISTS: ReadonlyMap<string, NodeAccessLists> = new Map();

function lists(
  entries: Record<string, { readers?: string[]; grantees?: string[] }>,
): ReadonlyMap<string, NodeAccessLists> {
  return new Map(
    Object.entries(entries).map(([id, value]) => [
      id,
      {
        readers: new Set(value.readers ?? []),
        grantees: new Set(value.grantees ?? []),
      },
    ]),
  );
}

/** 技术部 ─ 后端组 ─ 接口规范;另有市场部(与前者无关) */
const FLAT: ReadableNode[] = [
  node('dept-tech', null, 'u-alice'),
  node('grp-be', 'dept-tech', 'u-bob'),
  node('doc-api', 'grp-be', 'u-carol'),
  node('dept-mkt', null, 'u-dave'),
];

describe('readableNodeIds —— 默认全公开时人人可读', () => {
  it('没有任何受限节点时,所有人都读到全部', () => {
    const ids = readableNodeIds('u-nobody', FLAT, NO_LISTS);
    expect([...ids].sort()).toEqual(['dept-mkt', 'dept-tech', 'doc-api', 'grp-be']);
  });

  it('★ 未知节点(表里查不到)不因为保密而隐藏', () => {
    // 保密是**加法**,不该顺手少给东西。这里若返回不可读,表现是
    // 「首页偶尔少几个节点」,而且刷新一次可能又有了 —— 最难查的那种。
    const ids = readableNodeIds('u-x', [node('solo', 'missing-parent', 'u-alice')], NO_LISTS);
    expect(ids.has('solo')).toBe(true);
  });
});

describe('readableNodeIds —— 子树继承(最容易漏的一条)', () => {
  it('★★ 受限父节点下的 public 子节点,同样不可读', () => {
    // 这是整个保密功能的要害。只判「自己是不是 restricted」的实现会在这里放行,
    // 于是受限部门下面的每一篇文档都对全公司可见 —— 保密形同虚设,而且不报任何错。
    const nodes = [
      node('dept-tech', null, 'u-alice', 'restricted'),
      node('grp-be', 'dept-tech', 'u-bob'),
      node('doc-api', 'grp-be', 'u-carol'),
    ];
    const ids = readableNodeIds('u-stranger', nodes, lists({ 'dept-tech': {} }));
    expect(ids.has('dept-tech')).toBe(false);
    expect(ids.has('grp-be')).toBe(false);
    expect(ids.has('doc-api')).toBe(false);
  });

  it('★ 受限节点不能影响它的兄弟分支', () => {
    // 用前缀匹配代替祖先链的实现会在这里出错,而那种错误不报错,
    // 只表现为「别的部门的文档凭空消失」。
    const nodes = [
      node('dept-tech', null, 'u-alice', 'restricted'),
      node('dept-mkt', null, 'u-dave'),
    ];
    const ids = readableNodeIds('u-stranger', nodes, lists({ 'dept-tech': {} }));
    expect(ids.has('dept-mkt')).toBe(true);
  });

  it('深层链上任意一层受限,整条链都不可读', () => {
    const nodes = [
      node('a', null, 'u-alice'),
      node('b', 'a', 'u-bob'),
      node('c', 'b', 'u-carol', 'restricted'),
      node('d', 'c', 'u-dan'),
    ];
    const ids = readableNodeIds('u-stranger', nodes, lists({ c: {} }));
    expect([...ids].sort()).toEqual(['a', 'b']);
  });
});

describe('readableNodeIds —— 谁能穿过受限节点', () => {
  const NODES = [
    node('dept-tech', null, 'u-alice', 'restricted'),
    node('grp-be', 'dept-tech', 'u-bob'),
    node('doc-api', 'grp-be', 'u-carol'),
  ];
  const LISTS = lists({ 'dept-tech': { readers: ['u-reader'], grantees: ['u-editor'] } });

  it('受限节点自己的所有者读得到,而且能读到它下面的一切', () => {
    const ids = readableNodeIds('u-alice', NODES, LISTS);
    expect([...ids].sort()).toEqual(['dept-tech', 'doc-api', 'grp-be']);
  });

  it('★ 名单里的读者读得到(连同子树)', () => {
    const ids = readableNodeIds('u-reader', NODES, LISTS);
    expect(ids.has('dept-tech')).toBe(true);
    expect(ids.has('doc-api')).toBe(true);
  });

  it('★ 编辑被授权者也读得到 —— 否则会出现「能改但不能看」', () => {
    const ids = readableNodeIds('u-editor', NODES, LISTS);
    expect(ids.has('dept-tech')).toBe(true);
  });

  it('★ 名单之外的陌生人一个都读不到', () => {
    const ids = readableNodeIds('u-stranger', NODES, LISTS);
    expect(ids.size).toBe(0);
  });

  it('★ 子节点的所有者不能因为「拥有子节点」就看到受限的父节点', () => {
    // 方向不能反:越靠上权限越大,不是越靠下越大。
    // 写反的表现是「组员能看见部长设了限制的整个部门」。
    const ids = readableNodeIds('u-carol', NODES, LISTS);
    expect(ids.size).toBe(0);
  });
});

describe('readableNodeIds —— 链上有多个受限节点时必须逐个放行', () => {
  const NODES = [
    node('outer', null, 'u-alice', 'restricted'),
    node('mid', 'outer', 'u-bob'),
    node('inner', 'mid', 'u-carol', 'restricted'),
  ];

  it('★★ 只在**内层**名单里的人,读不到外层(否则就是泄露)', () => {
    // 只看「最近的那个受限节点」的实现会在这里放行。
    const ids = readableNodeIds('u-inner-only', NODES, lists({ inner: { readers: ['u-inner-only'] } }));
    expect(ids.has('inner')).toBe(false);
    expect(ids.has('outer')).toBe(false);
  });

  it('两层名单都在 → 可读', () => {
    const ids = readableNodeIds(
      'u-both',
      NODES,
      lists({ outer: { readers: ['u-both'] }, inner: { readers: ['u-both'] } }),
    );
    expect([...ids].sort()).toEqual(['inner', 'mid', 'outer']);
  });

  it('★★ 内层受限**挡不住外层的所有者** —— 这是模型的必然结果,不是 bug', () => {
    // ⚠️ 这条我一开始写反了(断言 alice 看不到 inner),跑出来才发现:
    // inner 的所有者链是 inner → mid → outer,而 alice 是 outer 的所有者,
    // 所以**她本来就在 inner 的祖先链上** —— 「越靠上权限越大」这套模型下,
    // 内层再设一道限制也挡不住她。
    //
    // 这不是缺陷,而是必须让用户知道的**语义边界**:
    // 「受限」防的是**平级与下级**,不防上级。想对部长本人保密,
    // 现有的 visibility 做不到 —— 那需要把节点挪到他管不着的地方,
    // 或者引入「所有者也不能看」这种新语义(那会推翻权限模型的一条基本规则)。
    const ids = readableNodeIds('u-alice', NODES, lists({ inner: { readers: ['u-carol'] } }));
    expect(ids.has('outer')).toBe(true);
    expect(ids.has('mid')).toBe(true);
    expect(ids.has('inner')).toBe(true);

    // 对照:与这条链无关的人,两层都看不到
    const stranger = readableNodeIds('u-stranger', NODES, lists({ inner: { readers: ['u-carol'] } }));
    expect(stranger.size).toBe(0);
  });
});

describe('readableNodeIds —— 边界', () => {
  it('空输入返回空集合', () => {
    expect(readableNodeIds('u-x', [], NO_LISTS).size).toBe(0);
  });

  it('受限但名单表里没有它的条目 → 按空名单处理(不放行)', () => {
    // 少了这个兜底会抛异常,而抛异常的表现是「整棵树打不开」——
    // 比「看不见」更糟:所有人都用不了。
    const ids = readableNodeIds('u-x', [node('r', null, 'u-alice', 'restricted')], NO_LISTS);
    expect(ids.size).toBe(0);
  });

  it('可见性字段是未知值时按 public 处理(脏数据不该让人突然看不见东西)', () => {
    const ids = readableNodeIds('u-x', [node('weird', null, 'u-alice', 'whatever')], NO_LISTS);
    expect(ids.has('weird')).toBe(true);
  });
});
