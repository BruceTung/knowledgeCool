/**
 * 四条铁律的单元测试 —— DESIGN.md §5.3。
 * 这四条是「错了不会立刻报错」的典型,必须有测试兜住(DESIGN.md §12)。
 */
import { describe, expect, it } from 'vitest';

import {
  SUPER_ADMIN_EFFECTIVE_ROLE,
  effectiveRoleFrom,
  resolveRoleAlongChain,
  ruleMatches,
  type ChainNode,
  type PermissionRule,
  type SubjectContext,
} from '../src/permission.js';

const ALICE: SubjectContext = { userId: 'u-alice', departments: ['产品部'] };
const BOB: SubjectContext = { userId: 'u-bob', departments: ['研发部'] };

const rules = (...list: PermissionRule[]): readonly PermissionRule[] => list;

const allowUser = (userId: string, role: PermissionRule['role']): PermissionRule => ({
  subjectType: 'user',
  subjectId: userId,
  role,
  deny: false,
});

const allowGroup = (dept: string, role: PermissionRule['role']): PermissionRule => ({
  subjectType: 'group',
  subjectId: dept,
  role,
  deny: false,
});

const denyUser = (userId: string): PermissionRule => ({
  subjectType: 'user',
  subjectId: userId,
  role: 'none',
  deny: true,
});

/** 造一条从根到自身的链:root → mid → leaf。 */
function chainOf(root: ChainNode, mid: ChainNode, leaf: ChainNode): ChainNode[] {
  return [root, mid, leaf];
}

describe('ruleMatches:命中主体', () => {
  it('user 规则按 userId 精确匹配', () => {
    expect(ruleMatches(allowUser('u-alice', 'editor'), ALICE)).toBe(true);
    expect(ruleMatches(allowUser('u-alice', 'editor'), BOB)).toBe(false);
  });

  it('group 规则按部门名匹配', () => {
    expect(ruleMatches(allowGroup('产品部', 'viewer'), ALICE)).toBe(true);
    expect(ruleMatches(allowGroup('研发部', 'viewer'), ALICE)).toBe(false);
  });

  it('用户不属于任何部门时,group 规则不命中', () => {
    const noDept: SubjectContext = { userId: 'u-x', departments: [] };
    expect(ruleMatches(allowGroup('产品部', 'viewer'), noDept)).toBe(false);
  });
});

describe('铁律一 · 默认继承:不写规则 = 继承,而不是无权', () => {
  it('整条链上没有任何规则时返回 null(交给调用方回退空间角色)', () => {
    const chain: ChainNode[] = [
      { pageId: 'root', rules: [] },
      { pageId: 'mid', rules: [] },
      { pageId: 'leaf', rules: [] },
    ];
    expect(resolveRoleAlongChain(chain, ALICE)).toBeNull();
  });

  it('回退到空间角色', () => {
    const chain: ChainNode[] = [{ pageId: 'leaf', rules: [] }];
    expect(effectiveRoleFrom(chain, ALICE, 'commenter')).toBe('commenter');
  });

  it('链上无规则且不是空间成员 → none', () => {
    const chain: ChainNode[] = [{ pageId: 'leaf', rules: [] }];
    expect(effectiveRoleFrom(chain, ALICE, null)).toBe('none');
  });

  it('祖先有规则时,无需在子节点重复声明即可继承', () => {
    const chain = chainOf(
      { pageId: 'root', rules: rules(allowUser('u-alice', 'editor')) },
      { pageId: 'mid', rules: [] },
      { pageId: 'leaf', rules: [] },
    );
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('editor');
  });
});

describe('铁律二 · 就近覆盖:子节点显式规则优先于祖先', () => {
  it('空间整体只读,但这一篇放开编辑', () => {
    const chain = chainOf(
      { pageId: 'root', rules: rules(allowGroup('产品部', 'viewer')) },
      { pageId: 'mid', rules: [] },
      { pageId: 'leaf', rules: rules(allowUser('u-alice', 'editor')) },
    );
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('editor');
  });

  it('更细的层也可以把权限收紧', () => {
    const chain = chainOf(
      { pageId: 'root', rules: rules(allowGroup('产品部', 'editor')) },
      { pageId: 'mid', rules: [] },
      { pageId: 'leaf', rules: rules(allowUser('u-alice', 'viewer')) },
    );
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('viewer');
  });

  it('沿途多层的 allow 取最靠近自身的那一层', () => {
    const chain = chainOf(
      { pageId: 'root', rules: rules(allowUser('u-alice', 'viewer')) },
      { pageId: 'mid', rules: rules(allowUser('u-alice', 'commenter')) },
      { pageId: 'leaf', rules: rules(allowUser('u-alice', 'editor')) },
    );
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('editor');
  });

  it('链上命中的角色不会回退到空间角色,哪怕空间角色更高', () => {
    const chain: ChainNode[] = [{ pageId: 'leaf', rules: rules(allowUser('u-alice', 'viewer')) }];
    expect(effectiveRoleFrom(chain, ALICE, 'admin')).toBe('viewer');
  });
});

describe('铁律三 · 拒绝优先:deny 一票否决,不受层级影响', () => {
  it('祖先的 deny 压过子节点的 allow', () => {
    const chain = chainOf(
      { pageId: 'root', rules: rules(denyUser('u-alice')) },
      { pageId: 'mid', rules: [] },
      { pageId: 'leaf', rules: rules(allowUser('u-alice', 'editor')) },
    );
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('none');
  });

  it('自身节点的 deny 压过自身节点的 allow', () => {
    const chain: ChainNode[] = [
      {
        pageId: 'leaf',
        rules: rules(allowUser('u-alice', 'editor'), denyUser('u-alice')),
      },
    ];
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('none');
  });

  it('deny 命中即短路:即使空间角色是 admin 也不放行', () => {
    const chain = chainOf(
      { pageId: 'root', rules: [] },
      { pageId: 'mid', rules: [] },
      { pageId: 'leaf', rules: rules(denyUser('u-alice')) },
    );
    expect(effectiveRoleFrom(chain, ALICE, 'admin')).toBe('none');
  });

  it('deny 只作用于被 deny 的人,不影响其他人', () => {
    const chain = chainOf(
      { pageId: 'root', rules: rules(denyUser('u-alice'), allowGroup('研发部', 'editor')) },
      { pageId: 'mid', rules: [] },
      { pageId: 'leaf', rules: [] },
    );
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('none');
    expect(resolveRoleAlongChain(chain, BOB)).toBe('editor');
  });

  it('deny 一个不存在的用户不影响任何人', () => {
    const chain: ChainNode[] = [
      { pageId: 'leaf', rules: rules(denyUser('u-nobody'), allowUser('u-alice', 'viewer')) },
    ];
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('viewer');
  });
});

describe('铁律四(实现补充)· 同层多规则:user 比 group 更具体', () => {
  it('同一节点上 user 规则压过 group 规则', () => {
    const chain: ChainNode[] = [
      {
        pageId: 'leaf',
        rules: rules(allowGroup('产品部', 'viewer'), allowUser('u-alice', 'editor')),
      },
    ];
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('editor');
  });

  it('顺序颠倒也不影响结果(不依赖规则的物理顺序)', () => {
    const chain: ChainNode[] = [
      {
        pageId: 'leaf',
        rules: rules(allowUser('u-alice', 'editor'), allowGroup('产品部', 'viewer')),
      },
    ];
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('editor');
  });

  it('同层的 group deny 依然优先于 user allow', () => {
    const chain: ChainNode[] = [
      {
        pageId: 'leaf',
        rules: rules(allowUser('u-alice', 'editor'), {
          subjectType: 'group',
          subjectId: '产品部',
          role: 'none',
          deny: true,
        }),
      },
    ];
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('none');
  });
});

describe('超管与边界', () => {
  it('超管的有效角色是 admin', () => {
    expect(SUPER_ADMIN_EFFECTIVE_ROLE).toBe('admin');
  });

  it('空链不会崩,且回退空间角色', () => {
    expect(resolveRoleAlongChain([], ALICE)).toBeNull();
    expect(effectiveRoleFrom([], ALICE, 'viewer')).toBe('viewer');
  });

  it('页面规则里的 none(非 deny)也能显式降权', () => {
    const chain = chainOf(
      { pageId: 'root', rules: rules(allowGroup('产品部', 'editor')) },
      { pageId: 'mid', rules: [] },
      {
        pageId: 'leaf',
        rules: rules({ subjectType: 'user', subjectId: 'u-alice', role: 'none', deny: false }),
      },
    );
    expect(resolveRoleAlongChain(chain, ALICE)).toBe('none');
  });

  it('入参数组不被修改', () => {
    const leafRules = rules(allowGroup('产品部', 'viewer'), allowUser('u-alice', 'editor'));
    const chain: ChainNode[] = [{ pageId: 'leaf', rules: leafRules }];
    const before = [...leafRules];
    resolveRoleAlongChain(chain, ALICE);
    expect([...leafRules]).toEqual(before);
  });
});
