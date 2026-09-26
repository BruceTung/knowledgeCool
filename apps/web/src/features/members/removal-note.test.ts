/**
 * 移出成员的确认文案测试(v2.4)。
 *
 * 这几句话是这件事的**安全边界**:管理员是照它决定要不要动的。
 * 尤其是「移出归属不改变所有权」这一句 —— 漏掉的话,
 * 会有人以为"把人从组里移出去"就等于撤了他的组长。
 */
import type { NodeMemberView } from '@knowledgecool/shared';
import { describe, expect, it } from 'vitest';

import { describeRemoval } from './removal-note';

function member(overrides: Partial<NodeMemberView> = {}): NodeMemberView {
  return {
    userId: 'u-zhao',
    name: '赵敏',
    employeeNo: 'KC004',
    status: 'active',
    memberNodeIds: ['n-group'],
    memberPaths: ['技术部 / 后端组'],
    otherPaths: [],
    isOwnerHere: false,
    isAncestorOwner: false,
    ...overrides,
  };
}

describe('describeRemoval', () => {
  it('第一行说清楚是谁、从哪儿移出', () => {
    const text = describeRemoval(member(), '后端组');
    expect(text.split('\n')[0]).toBe('把 赵敏(KC004)从「后端组」移出?');
  });

  it('这是唯一一条归属时,明确说"他将不属于任何部门 / 组"', () => {
    const text = describeRemoval(member(), '后端组');
    expect(text).toContain('这是他唯一的组织归属');
    expect(text).toContain('不能再在别人下面新建');
  });

  it('他在别处还有归属时,只提示组织范围会变小', () => {
    const text = describeRemoval(
      member({
        memberNodeIds: ['n-group', 'n-dept'],
        memberPaths: ['技术部 / 后端组', '技术部'],
        otherPaths: ['市场部 / CRM 项目'],
      }),
      '技术部',
    );
    expect(text).not.toContain('这是他唯一的组织归属');
    expect(text).toContain('他会失去这里的组织范围');
    expect(text).toContain('能被他授权的人会变少');
  });

  it('他是这个节点的所有者时,必须点明"移出归属不改变所有权"', () => {
    const text = describeRemoval(
      member({ isOwnerHere: true, memberNodeIds: ['n-group', 'n-other'], memberPaths: ['技术部 / 后端组', '技术部'] }),
      '后端组',
    );
    expect(text).toContain('移出归属不会改变这一点');
    expect(text).toContain('他仍然能改、能管这里');
  });

  /**
   * ⚠️ 这条是**实渲染验证**时才发现的:`window.confirm` 是纯文本,
   * 写给 Markdown 看的 `**加粗**` 会把两个星号原样显示出来 ——
   * 真实弹窗里就是「移出归属**不会**改变这一点」。
   * 用一个断言把这类符号钉死,否则下次写文案的人还会这么干。
   */
  it('是纯文本:不能出现 Markdown 记号(confirm 不会渲染它们)', () => {
    const text = describeRemoval(member({ isOwnerHere: true }), '后端组');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
  });

  it('他是上级所有者时给出对应提示,且不与所有者那句重复', () => {
    const text = describeRemoval(
      member({ isAncestorOwner: true, memberNodeIds: ['n-dept'], otherPaths: ['市场部'] }),
      '技术部',
    );
    expect(text).toContain('上级所有者');
    expect(text).not.toContain('移出归属不会改变这一点');
  });

  it('「本节点所有者」优先于「上级所有者」', () => {
    const text = describeRemoval(
      member({ isOwnerHere: true, isAncestorOwner: true, memberNodeIds: ['a', 'b'] }),
      '后端组',
    );
    expect(text).toContain('他正是「后端组」的所有者');
    expect(text).not.toContain('他是上级所有者');
  });

  it('永远是多行 —— 提示不挤在第一行里', () => {
    expect(describeRemoval(member(), '后端组').split('\n').length).toBeGreaterThan(2);
  });
});
