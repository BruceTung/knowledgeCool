/**
 * 页面权限判定的模块级逻辑测试(DESIGN.md §5)。
 *
 * 这里测的是 `permission.service.ts` 里那几个**纯函数** ——
 * 带 IO 的壳子(查库、Redis)由端到端验收覆盖。
 *
 * 最关键的一条是 `explainChain` 与 shared 的 `resolveRoleAlongChain` 的**等价性**:
 * UI 的「有效权限推导链」是判定逻辑的第二份实现(第一份在 shared),
 * 两份一旦漂移,管理员看到的推导链就会与真实判定不符 ——
 * 那是最容易把人误导到"配错了权限"的一种 bug。
 */
import { describe, expect, it } from 'vitest';

import {
  effectiveRoleFrom,
  toEffectiveRole,
  type PermissionRule,
  type SpaceRole,
  type SubjectContext,
} from '@knowledgecool/shared';

import { chainOf, explainChain, generationKey } from './permission.service.js';

const CTX: SubjectContext = { userId: 'u-1', departments: ['技术部'] };

const OTHER_DEPT: SubjectContext = { userId: 'u-1', departments: ['市场部'] };

function rule(
  subjectId: string,
  role: PermissionRule['role'],
  options: { subjectType?: 'user' | 'group'; deny?: boolean } = {},
): PermissionRule {
  return {
    subjectType: options.subjectType ?? 'user',
    subjectId,
    role,
    deny: options.deny ?? false,
  };
}

/**
 * 从推导链反推出「当前生效角色」。
 *
 * 这与 `effectiveRoleFrom` 的关系是测试的核心断言对象:
 * 两者必须对任意输入给出**相同**结果。
 */
function roleFromChain(
  steps: ReturnType<typeof explainChain>,
  spaceRole: SpaceRole | null,
): string {
  if (steps.some((step) => step.source === 'deny')) return 'none';
  const lastWithRule = [...steps].reverse().find((step) => step.role !== null);
  return lastWithRule?.role ?? toEffectiveRole(spaceRole);
}

describe('explainChain 与 resolveRoleAlongChain 的等价性', () => {
  const cases: ReadonlyArray<{
    name: string;
    chain: { pageId: string; rules: PermissionRule[] }[];
    ctx: SubjectContext;
    spaceRole: SpaceRole;
  }> = [
    {
      name: '链上完全没有规则 → 回退空间角色',
      chain: [
        { pageId: 'root', rules: [] },
        { pageId: 'child', rules: [] },
      ],
      ctx: CTX,
      spaceRole: 'viewer',
    },
    {
      name: '只有根层有规则',
      chain: [
        { pageId: 'root', rules: [rule('u-1', 'editor')] },
        { pageId: 'child', rules: [] },
      ],
      ctx: CTX,
      spaceRole: 'viewer',
    },
    {
      name: '子层覆盖父层(就近覆盖)',
      chain: [
        { pageId: 'root', rules: [rule('u-1', 'editor')] },
        { pageId: 'child', rules: [rule('u-1', 'viewer')] },
      ],
      ctx: CTX,
      spaceRole: 'admin',
    },
    {
      name: '调降:页面规则把空间管理员压成只读',
      chain: [{ pageId: 'root', rules: [rule('u-1', 'viewer')] }],
      ctx: CTX,
      spaceRole: 'admin',
    },
    {
      name: '⚠️ deny 短路:即使更深的层给了 editor 也不能翻案',
      chain: [
        { pageId: 'root', rules: [rule('u-1', 'editor', { deny: true })] },
        { pageId: 'child', rules: [rule('u-1', 'editor')] },
      ],
      ctx: CTX,
      spaceRole: 'admin',
    },
    {
      name: '同层同时命中 user 与 group → user 更具体,胜出',
      chain: [
        {
          pageId: 'root',
          rules: [rule('技术部', 'viewer', { subjectType: 'group' }), rule('u-1', 'editor')],
        },
      ],
      ctx: CTX,
      spaceRole: 'viewer',
    },
    {
      name: '同层 group 命中但 user 未命中 → 用 group 的',
      chain: [
        {
          pageId: 'root',
          rules: [rule('技术部', 'commenter', { subjectType: 'group' }), rule('u-999', 'editor')],
        },
      ],
      ctx: CTX,
      spaceRole: 'viewer',
    },
    {
      name: '规则主体不是我 → 等于没规则,回退空间角色',
      chain: [{ pageId: 'root', rules: [rule('u-999', 'editor')] }],
      ctx: CTX,
      spaceRole: 'editor',
    },
    {
      name: '部门不匹配 → 规则不命中',
      chain: [
        { pageId: 'root', rules: [rule('技术部', 'editor', { subjectType: 'group' })] },
      ],
      ctx: OTHER_DEPT,
      spaceRole: 'viewer',
    },
    {
      name: '最深一层显式写成 none(不继承)',
      chain: [
        { pageId: 'root', rules: [rule('u-1', 'editor')] },
        { pageId: 'child', rules: [rule('u-1', 'none')] },
      ],
      ctx: CTX,
      spaceRole: 'admin',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const pure = effectiveRoleFrom(testCase.chain, testCase.ctx, testCase.spaceRole);
      const explained = roleFromChain(
        explainChain(testCase.chain, testCase.ctx),
        testCase.spaceRole,
      );
      expect(explained).toBe(pure);
    });
  }

  it('规则顺序颠倒结果不变 —— 结论不依赖数据库里的物理顺序', () => {
    const rules = [
      rule('技术部', 'viewer', { subjectType: 'group' }),
      rule('u-1', 'editor'),
      rule('u-2', 'commenter'),
    ];
    const forward = effectiveRoleFrom([{ pageId: 'p', rules }], CTX, 'viewer');
    const backward = effectiveRoleFrom([{ pageId: 'p', rules: [...rules].reverse() }], CTX, 'viewer');
    expect(forward).toBe('editor');
    expect(backward).toBe('editor');
  });
});

describe('explainChain 的输出形状(UI 推导链的数据源)', () => {
  it('deny 之后短路:返回的步数止于那一层', () => {
    const steps = explainChain(
      [
        { pageId: 'root', rules: [] },
        { pageId: 'mid', rules: [rule('u-1', 'viewer', { deny: true })] },
        { pageId: 'leaf', rules: [rule('u-1', 'editor')] },
      ],
      CTX,
      [
        { title: '根', depth: 0 },
        { title: '中间', depth: 1 },
        { title: '叶子', depth: 2 },
      ],
    );

    expect(steps).toHaveLength(2);
    expect(steps.at(-1)).toMatchObject({ pageId: 'mid', role: 'none', source: 'deny' });
  });

  it('未命中的层标 source=none 且 role=null(表示"这一层继承")', () => {
    const steps = explainChain(
      [
        { pageId: 'root', rules: [] },
        { pageId: 'leaf', rules: [rule('u-1', 'editor')] },
      ],
      CTX,
    );

    expect(steps[0]).toMatchObject({ role: null, source: 'none' });
    expect(steps[1]).toMatchObject({ role: 'editor', source: 'rule' });
  });

  it('带上标题与深度,供 UI 直接渲染', () => {
    const steps = explainChain(
      [{ pageId: 'root', rules: [rule('u-1', 'editor')] }],
      CTX,
      [{ title: '研发中心首页', depth: 0 }],
    );
    expect(steps[0]?.pageTitle).toBe('研发中心首页');
  });
});

describe('chainOf —— 按父子指针走出「根 → 自身」', () => {
  const nodes = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
  ];

  it('顺序必须是从根到自身 —— 反了判定结果全错', () => {
    const chain = chainOf('c', nodes, new Map());
    expect(chain.map((node) => node.pageId)).toEqual(['a', 'b', 'c']);
  });

  it('带上各节点的规则', () => {
    const rules = new Map([['b', [rule('u-1', 'editor')]]]);
    const chain = chainOf('c', nodes, rules);
    expect(chain[1]?.rules).toHaveLength(1);
    expect(chain[0]?.rules).toHaveLength(0);
  });

  it('父节点不在集合里时当作根处理,不丢节点', () => {
    const chain = chainOf('orphan', [{ id: 'orphan', parentId: 'ghost' }], new Map());
    expect(chain.map((node) => node.pageId)).toEqual(['orphan']);
  });

  it('数据损坏成环时不会死循环', () => {
    const cyclic = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    const chain = chainOf('x', cyclic, new Map());
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThan(1001);
  });
});

describe('缓存键', () => {
  it('世代号按空间隔离 —— 改一个空间的规则不该影响另一个空间', () => {
    expect(generationKey('sp-1')).toBe('kc:perm:gen:sp-1');
    expect(generationKey('sp-2')).not.toBe(generationKey('sp-1'));
  });
});
