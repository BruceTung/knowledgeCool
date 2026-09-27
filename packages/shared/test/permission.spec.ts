/**
 * 权限判定的纯函数测试(v2.12)。
 *
 * ## 为什么这一组最该有测试
 *
 * `permission.ts` 的文件头自己写着:权限判定属于「**错了不会立刻报错**」的
 * 高危逻辑,必须能被单测整体覆盖。而从 v2.0 重写算起,四个函数一行测试都没有 ——
 * 判错了的表现不是 500,而是「某个人静默地能改/能看他本不该碰的东西」。
 *
 * v2.12 给这个文件加了**真正的读权限**(此前 canRead 恒为 true),
 * 所以这一组现在多了「保密」那一半。
 */
import { describe, expect, it } from 'vitest';

import {
  canCreateUnder,
  canEdit,
  canGrantTo,
  canManage,
  canManageReaders,
  canRead,
  isWithinSubtree,
  type Actor,
  type Chain,
  type ChainNode,
  type NodeAccessLists,
} from '../src/permission.js';
import type { NodeVisibility } from '../src/node.js';

const ALICE: Actor = { id: 'u-alice', isSuperAdmin: false };
const BOB: Actor = { id: 'u-bob', isSuperAdmin: false };
const CAROL: Actor = { id: 'u-carol', isSuperAdmin: false };
const DAVE: Actor = { id: 'u-dave', isSuperAdmin: false };
/**
 * 与这条链**完全无关**的第五个人。
 *
 * ⚠️ 专门给「名单外的人读不到」这类用例。写这组测试时我第一版用 BOB 当"外人",
 * 而他其实是 CHAIN 里 n-group 的所有者 —— 祖先链所有者**本来就该读得到**,
 * 于是那条断言测的是假东西。(与 canEdit 那组踩过的是同一个坑:
 * 用了一个其实在链上的人当"无关者"。)
 */
const EVE: Actor = { id: 'u-eve', isSuperAdmin: false };
const ADMIN: Actor = { id: 'u-admin', isSuperAdmin: true };

function node(
  id: string,
  ownerId: string,
  opts: { visibility?: NodeVisibility; createdBy?: string; title?: string; depth?: number } = {},
): ChainNode {
  return {
    id,
    ownerId,
    title: opts.title ?? id,
    depth: opts.depth ?? 1,
    visibility: opts.visibility ?? 'public',
    createdBy: opts.createdBy ?? ownerId,
  };
}

/** 根(部门)所有者 = alice → 组所有者 = bob → 自身所有者 = carol */
const CHAIN: Chain = {
  self: node('n-page', 'u-carol'),
  ancestors: [node('n-dept', 'u-alice', { depth: 0 }), node('n-group', 'u-bob')],
};

const NOBODY: ReadonlySet<string> = new Set<string>();

/** 造一份「某个节点上是受限的,名单里有谁」的映射。 */
function lists(
  restrictedId: string,
  opts: { readers?: string[]; grantees?: string[] } = {},
): ReadonlyMap<string, NodeAccessLists> {
  return new Map([
    [
      restrictedId,
      {
        readers: new Set(opts.readers ?? []),
        grantees: new Set(opts.grantees ?? []),
      },
    ],
  ]);
}

describe('canEdit —— 所有者 / 祖先链所有者 / 被授权者', () => {
  it('自身所有者能改', () => {
    expect(canEdit(CAROL, CHAIN, NOBODY)).toBe(true);
  });

  it('★ 祖先链上任一节点是所有者就能改 —— 「越靠上权限越大」', () => {
    // 这一条最容易写反:旧模型是「越靠下越具体、就近覆盖」,新模型相反。
    // 写反的表现是**组长改不动自己组里组员建的东西**,而没有测试只能靠手试。
    expect(canEdit(BOB, CHAIN, NOBODY)).toBe(true);
    expect(canEdit(ALICE, CHAIN, NOBODY)).toBe(true);
  });

  it('被授权者能改(即使他不是所有者)', () => {
    expect(canEdit(DAVE, CHAIN, new Set(['u-dave']))).toBe(true);
  });

  it('被授权名单只有精确命中才算,不做前缀/包含匹配', () => {
    expect(canEdit(DAVE, CHAIN, new Set(['u-davey']))).toBe(false);
    expect(canEdit(DAVE, CHAIN, new Set(['u-dav']))).toBe(false);
  });

  it('⚠️ 超管不是旁路 —— 他与内容权限无关(§4.3)', () => {
    expect(canEdit(ADMIN, CHAIN, NOBODY)).toBe(false);
    expect(canManage(ADMIN, CHAIN)).toBe(false);
  });
});

describe('canManage —— 能管(可转授),被授权者不在其列', () => {
  it('自身所有者与祖先链所有者能管', () => {
    expect(canManage(CAROL, CHAIN)).toBe(true);
    expect(canManage(BOB, CHAIN)).toBe(true);
    expect(canManage(ALICE, CHAIN)).toBe(true);
  });

  it('★ 被授权者能改但不能管 —— 他不能把权限再转授给别人', () => {
    expect(canEdit(DAVE, CHAIN, new Set(['u-dave']))).toBe(true);
    expect(canManage(DAVE, CHAIN)).toBe(false);
  });
});

describe('canCreateUnder —— 与 canEdit 是两件事', () => {
  const PARENT: Chain = {
    self: node('n-group', 'u-bob'),
    ancestors: [node('n-dept', 'u-alice', { depth: 0 })],
  };

  it('能改父节点 → 能建', () => {
    expect(canCreateUnder(BOB, PARENT, NOBODY, false)).toBe(true);
  });

  it('★ 对父节点没有 canEdit、但归属在它范围内 → 仍然能建', () => {
    expect(canEdit(CAROL, PARENT, NOBODY)).toBe(false);
    expect(canCreateUnder(CAROL, PARENT, NOBODY, true)).toBe(true);
  });

  it('既不能改、又不在范围内 → 不能建', () => {
    expect(canCreateUnder(CAROL, PARENT, NOBODY, false)).toBe(false);
  });
});

describe('canGrantTo —— 能管 + 目标必须在组织范围内', () => {
  it('能管且目标在范围内 → 允许', () => {
    expect(
      canGrantTo({ actor: BOB, chain: CHAIN, targetUserId: 'u-carol', targetInOperatorScope: true }),
    ).toBe(true);
  });

  it('★ 目标不在操作者组织范围内 → 拒绝(防横向越权)', () => {
    expect(
      canGrantTo({ actor: BOB, chain: CHAIN, targetUserId: 'u-x', targetInOperatorScope: false }),
    ).toBe(false);
  });

  it('不能管的人一律不能授权 —— 哪怕目标在范围内', () => {
    expect(
      canGrantTo({ actor: DAVE, chain: CHAIN, targetUserId: 'u-x', targetInOperatorScope: true }),
    ).toBe(false);
  });

  it('把自己列进名单不构成越权(本来就该能改),允许', () => {
    expect(
      canGrantTo({ actor: ALICE, chain: CHAIN, targetUserId: ALICE.id, targetInOperatorScope: false }),
    ).toBe(true);
  });
});

describe('canRead —— v2.12 起它真的会返回 false', () => {
  it('链上全是 public → 谁都读得到(默认行为,绝大多数节点)', () => {
    expect(canRead(DAVE, CHAIN, new Map())).toBe(true);
    expect(canRead(ADMIN, CHAIN, new Map())).toBe(true);
  });

  it('★ 自身受限:名单里的人能读,名单外的人读不到', () => {
    const chain: Chain = {
      self: node('n-page', 'u-carol', { visibility: 'restricted' }),
      ancestors: CHAIN.ancestors,
    };
    const listsByNode = lists('n-page', { readers: ['u-dave'] });

    expect(canRead(DAVE, chain, listsByNode)).toBe(true);
    expect(canRead(EVE, chain, listsByNode)).toBe(false);
    // 对照:BOB 是这条链上 n-group 的所有者,他**本来就该**读得到 ——
    // 哪怕他不在名单里。(这条对照正是我第一版写错的地方。)
    expect(canRead(BOB, chain, listsByNode)).toBe(true);
  });

  it('★ 受限节点的所有者也读得到(不用把自己加进名单)', () => {
    const chain: Chain = {
      self: node('n-page', 'u-carol', { visibility: 'restricted' }),
      ancestors: CHAIN.ancestors,
    };
    expect(canRead(CAROL, chain, lists('n-page'))).toBe(true);
    // 祖先所有者也读得到 —— 越靠上权限越大
    expect(canRead(ALICE, chain, lists('n-page'))).toBe(true);
    expect(canRead(BOB, chain, lists('n-page'))).toBe(true);
  });

  it('★ 受限节点的**编辑被授权者**也读得到 —— 否则会出现「能改但不能看」', () => {
    const chain: Chain = {
      self: node('n-page', 'u-carol', { visibility: 'restricted' }),
      ancestors: CHAIN.ancestors,
    };
    expect(canRead(DAVE, chain, lists('n-page', { grantees: ['u-dave'] }))).toBe(true);
  });

  it('★ 祖先受限、自身 public:后代**继承**限制 —— 这是最容易漏的一条', () => {
    // 只判「自己是不是 restricted」的实现会在这里放行,于是受限部门下面的
    // 每一篇文档都对全公司可见 —— 保密形同虚设,而且**不报任何错**。
    const chain: Chain = {
      self: node('n-page', 'u-carol'),
      ancestors: [
        node('n-dept', 'u-alice', { depth: 0, visibility: 'restricted' }),
        node('n-group', 'u-bob'),
      ],
    };
    const listsByNode = lists('n-dept', { readers: ['u-dave'] });

    expect(canRead(DAVE, chain, listsByNode)).toBe(true);
    expect(canRead(EVE, chain, listsByNode)).toBe(false);
    // 部长是那个受限节点的所有者 → 仍然读得到
    expect(canRead(ALICE, chain, listsByNode)).toBe(true);
  });

  it('★★ 链上有**两个**受限节点时,必须每一个都放行', () => {
    // 只看「最近的那个受限节点」的实现会在这里放行:
    // dave 在里层名单里,于是外层那个受限部门也被他看到了 —— 那是泄露。
    const chain: Chain = {
      self: node('n-page', 'u-carol', { visibility: 'restricted' }),
      ancestors: [
        node('n-dept', 'u-alice', { depth: 0, visibility: 'restricted' }),
        node('n-group', 'u-bob'),
      ],
    };
    const listsByNode = new Map<string, NodeAccessLists>([
      ['n-dept', { readers: new Set<string>(), grantees: new Set<string>() }],
      ['n-page', { readers: new Set(['u-dave']), grantees: new Set<string>() }],
    ]);

    // 只在里层名单里 → 外层不放行 → 整条链不可读
    expect(canRead(DAVE, chain, listsByNode)).toBe(false);

    // 两层都加进去 → 可读
    const both = new Map<string, NodeAccessLists>([
      ['n-dept', { readers: new Set(['u-dave']), grantees: new Set<string>() }],
      ['n-page', { readers: new Set(['u-dave']), grantees: new Set<string>() }],
    ]);
    expect(canRead(DAVE, chain, both)).toBe(true);
  });
});

describe('canManageReaders —— 谁有权管理可见范围(v2.12)', () => {
  const chain: Chain = {
    self: node('n-page', 'u-carol', { createdBy: 'u-dave' }),
    ancestors: [node('n-dept', 'u-alice', { depth: 0 }), node('n-group', 'u-bob')],
  };

  it('创建者能管(用户指定的授权人)', () => {
    expect(canManageReaders(DAVE, chain)).toBe(true);
  });

  it('所有者链也能管 —— 少了这一条,创建者离职后名单会永久冻结', () => {
    expect(canManageReaders(CAROL, chain)).toBe(true);
    expect(canManageReaders(BOB, chain)).toBe(true);
    expect(canManageReaders(ALICE, chain)).toBe(true);
  });

  it('无关的人不能管', () => {
    const other: Actor = { id: 'u-other', isSuperAdmin: false };
    expect(canManageReaders(other, chain)).toBe(false);
    // 超管同样不在其列 —— 与内容权限一致
    expect(canManageReaders(ADMIN, chain)).toBe(false);
  });
});

describe('isWithinSubtree —— 前缀末尾的斜杠不能省', () => {
  it('自身算在子树里', () => {
    expect(isWithinSubtree('/p-1', '/p-1')).toBe(true);
  });

  it('真子节点算在子树里', () => {
    expect(isWithinSubtree('/p-1/p-2', '/p-1')).toBe(true);
    expect(isWithinSubtree('/p-1/p-2/p-3', '/p-1')).toBe(true);
  });

  it('★ /p-10 不能被当成 /p-1 的后代', () => {
    // 少了末尾斜杠,组织范围会整片错位(把别的部门的人算进自己的范围),
    // 而它不报错,只表现为「某某居然能授权给外部门的人」。
    expect(isWithinSubtree('/p-10', '/p-1')).toBe(false);
    expect(isWithinSubtree('/p-1x', '/p-1')).toBe(false);
  });

  it('兄弟节点不算在彼此的子树上', () => {
    expect(isWithinSubtree('/p-2', '/p-1')).toBe(false);
  });

  it('祖先不算在后代的子树里(方向不能反)', () => {
    expect(isWithinSubtree('/p-1', '/p-1/p-2')).toBe(false);
  });
});
