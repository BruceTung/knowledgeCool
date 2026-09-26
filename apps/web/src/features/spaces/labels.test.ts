/**
 * 角色措辞的完整性测试。
 *
 * 价值不在于「测了个常量」,而在于:**将来往 SPACE_ROLES 里加一个角色时,
 * 这里会立刻红**。否则新角色会在界面上露出一串英文枚举值,
 * 而且只在真实用到那个角色的空间里才看得出来。
 */
import { SPACE_ROLES } from '@knowledgecool/shared';
import { describe, expect, it } from 'vitest';

import { ROLE_HINTS, ROLE_LABELS, ROLE_OPTIONS } from './labels';

describe('角色措辞完整性', () => {
  it('每个空间角色都有中文标签', () => {
    for (const role of SPACE_ROLES) {
      expect(ROLE_LABELS[role], `角色 ${role} 缺少标签`).toBeTruthy();
    }
  });

  it('每个空间角色都有说明文案', () => {
    for (const role of SPACE_ROLES) {
      expect(ROLE_HINTS[role], `角色 ${role} 缺少说明`).toBeTruthy();
    }
  });

  it('标签里不残留英文枚举值', () => {
    for (const role of SPACE_ROLES) {
      expect(ROLE_LABELS[role]).not.toBe(role);
    }
  });

  it('下拉选项与角色枚举一一对应,且顺序一致', () => {
    expect(ROLE_OPTIONS.map((o) => o.value)).toEqual([...SPACE_ROLES]);
  });
});
