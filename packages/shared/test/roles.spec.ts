/**
 * 权限矩阵测试 —— 逐格对照 DESIGN.md §5.4 的表格。
 *
 * 这份期望值是**照着文档表格手抄的**,不是从 CAPABILITY_MIN_ROLE 反推的。
 * 否则测试只会证明「代码等于代码」,起不到交叉核对文档的作用。
 */
import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  CAPABILITY_MIN_ROLE,
  EFFECTIVE_ROLES,
  PAGE_RULE_ROLES,
  ROLE_RANK,
  SPACE_ROLES,
  atLeast,
  can,
  isEffectiveRole,
  isPageRuleRole,
  isSpaceRole,
  toEffectiveRole,
  type Capability,
  type EffectiveRole,
} from '../src/roles.js';

describe('角色枚举与 DESIGN.md §4.2 的 check 约束一致', () => {
  it('空间角色恰好是 admin/editor/commenter/viewer', () => {
    expect([...SPACE_ROLES]).toEqual(['admin', 'editor', 'commenter', 'viewer']);
  });

  it('页面规则角色不含 admin —— 空间管理层级不能通过页面规则授予', () => {
    expect([...PAGE_RULE_ROLES]).toEqual(['editor', 'commenter', 'viewer', 'none']);
    expect(PAGE_RULE_ROLES as readonly string[]).not.toContain('admin');
  });

  it('有效角色比空间角色多一个 none', () => {
    expect([...EFFECTIVE_ROLES]).toEqual(['admin', 'editor', 'commenter', 'viewer', 'none']);
  });
});

describe('角色强弱排序', () => {
  it('rank 严格递增:none < viewer < commenter < editor < admin', () => {
    expect(ROLE_RANK.none).toBeLessThan(ROLE_RANK.viewer);
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.commenter);
    expect(ROLE_RANK.commenter).toBeLessThan(ROLE_RANK.editor);
    expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.admin);
  });

  it('atLeast 对自己的角色恒为真', () => {
    for (const role of EFFECTIVE_ROLES) {
      expect(atLeast(role, role)).toBe(true);
    }
  });

  it('none 达不到任何要求', () => {
    for (const required of EFFECTIVE_ROLES) {
      expect(atLeast('none', required)).toBe(required === 'none');
    }
  });

  it('admin 满足一切要求', () => {
    for (const required of EFFECTIVE_ROLES) {
      expect(atLeast('admin', required)).toBe(true);
    }
  });
});

/**
 * DESIGN.md §5.4 权限矩阵的逐格转写。
 * 行 = 动作,列 = [viewer, commenter, editor, admin]。
 */
const MATRIX: ReadonlyArray<readonly [Capability, readonly [boolean, boolean, boolean, boolean]]> =
  [
    ['page.view', [true, true, true, true]],
    ['comment.create', [false, true, true, true]],
    ['comment.resolve.own', [false, true, true, true]],
    ['comment.resolve.any', [false, false, true, true]],
    ['page.create', [false, false, true, true]],
    ['page.edit', [false, false, true, true]],
    ['page.delete', [false, false, true, true]],
    ['page.restore', [false, false, true, true]],
    // 彻底删除是唯一不可逆的能力,门槛刻意比软删除高一级
    ['page.purge', [false, false, false, true]],
    ['page.permission.update', [false, false, false, true]],
    ['space.member.manage', [false, false, false, true]],
    ['audit.view', [false, false, false, true]],
  ];

describe('can() 与 DESIGN.md §5.4 权限矩阵逐格一致', () => {
  const columns: readonly EffectiveRole[] = ['viewer', 'commenter', 'editor', 'admin'];

  it('矩阵覆盖了每个已声明能力', () => {
    const covered = MATRIX.map(([capability]) => capability).sort();
    expect(covered).toEqual([...CAPABILITIES].sort());
  });

  for (const [capability, expected] of MATRIX) {
    it(`${capability} 在 只读/评论者/编辑者/管理员 下的判定正确`, () => {
      columns.forEach((role, index) => {
        expect(can(role, capability), `${capability} @ ${role}`).toBe(expected[index]);
      });
    });
  }

  it('none 对任何动作都是拒绝', () => {
    for (const capability of CAPABILITIES) {
      expect(can('none', capability)).toBe(false);
    }
  });

  it('每个能力的门槛角色确实是该行第一个 true 的列', () => {
    columns.forEach((role, index) => {
      for (const [capability, expected] of MATRIX) {
        if (CAPABILITY_MIN_ROLE[capability] === role) {
          expect(expected[index], `${capability} 的门槛应是 ${role}`).toBe(true);
          // 比门槛低一档必须为 false
          if (index > 0) {
            expect(expected[index - 1]).toBe(false);
          }
        }
      }
    });
  });
});

describe('运行时收敛:数据库里的脏值不能变成权限', () => {
  it('未知字符串一律收敛为 none', () => {
    for (const dirty of ['', 'ADMIN', 'Admin', 'owner', 'superuser', 'null', undefined, null]) {
      expect(toEffectiveRole(dirty as string | null | undefined)).toBe('none');
    }
  });

  it('合法角色原样返回', () => {
    for (const role of EFFECTIVE_ROLES) {
      expect(toEffectiveRole(role)).toBe(role);
    }
  });

  it('类型守卫拒绝非字符串与未知值', () => {
    expect(isEffectiveRole('editor')).toBe(true);
    expect(isEffectiveRole('owner')).toBe(false);
    expect(isEffectiveRole(123)).toBe(false);
    expect(isEffectiveRole(null)).toBe(false);
    expect(isSpaceRole('admin')).toBe(true);
    expect(isSpaceRole('none')).toBe(false);
    expect(isPageRuleRole('none')).toBe(true);
    expect(isPageRuleRole('admin')).toBe(false);
  });
});
