/**
 * 重置密码的确认文案测试(v2.5)。
 *
 * 这段话是这件事的**知情边界**:管理员是照它决定要不要点下去的。
 * 最要紧的是第二句 —— 只写"重置密码"的话,没人会想到
 * 那个人**正在编辑的内容会丢**。
 */
import type { OrgUserView } from '@knowledgecool/shared';
import { describe, expect, it } from 'vitest';

import { describeReset } from './reset-note';

function user(overrides: Partial<OrgUserView> = {}): OrgUserView {
  return {
    id: 'u-zhao',
    employeeNo: 'KC004',
    name: '赵敏',
    status: 'active',
    isSuperAdmin: false,
    scopePaths: ['技术部 / 后端组'],
    scopeNodeIds: ['n-group'],
    mustChangePassword: false,
    lastLoginAt: null,
    ...overrides,
  };
}

describe('describeReset', () => {
  it('第一行说清楚是谁、改成什么', () => {
    const text = describeReset(user());
    expect(text.split('\n')[0]).toContain('赵敏');
    expect(text.split('\n')[0]).toContain('KC004');
    expect(text.split('\n')[0]).toContain('123456');
  });

  it('★ 必须说明「会立刻踢他下线」—— 这一条最容易漏,后果也最直接', () => {
    const text = describeReset(user());
    expect(text).toContain('立刻失效');
    // 而且要说明后果,不能只说"会失效"
    expect(text).toContain('没保存');
  });

  it('说明他下次登录要先改密(否则会被当成"又给了个初始密码")', () => {
    expect(describeReset(user())).toContain('改成自己的密码');
  });

  it('说明这个动作会留痕', () => {
    expect(describeReset(user())).toContain('审计日志');
  });

  it('他本来就在初始密码上时,多一句提醒(别指望重置能解决登不上的问题)', () => {
    const text = describeReset(user({ mustChangePassword: true }));
    expect(text).toContain('本来就是初始值');
  });

  it('已经改过密码的人,不提那句多余的提醒', () => {
    expect(describeReset(user({ mustChangePassword: false }))).not.toContain('本来就是初始值');
  });

  /**
   * ⚠️ 这条是**实渲染验证**时才发现的:`window.confirm` 是纯文本,
   * 写给 Markdown 看的 `**加粗**` 会把两个星号原样显示出来
   * (实际弹窗里就是「他**当前所有登录会立刻失效**」)。
   * 用一个断言把这类符号钉死 —— 否则下次写文案的人还会这么干。
   */
  it('是纯文本:不能出现 Markdown 记号(confirm 不会渲染它们)', () => {
    const text = describeReset(user({ mustChangePassword: true }));
    expect(text).not.toContain('**');
    expect(text).not.toContain('##');
    expect(text).not.toContain('`');
  });
});
