/**
 * 移出成员时的确认文案(v2.4)。
 *
 * 单独抽成一个纯函数而不是写在组件里,理由与 `tree-utils` 一样:
 * **这几句话是这件事的安全边界**。
 *
 * 「移出组织归属」有两个后果经常被误解:
 *   1. 它**不改变所有权** —— 被移出的人可能仍然是这个节点的所有者(组长),
 *      他该能改的还是能改,该能管的还是能管。
 *   2. 它**会缩小他的组织范围** —— 他能授权给别人的人变少了;
 *      而如果那是他最后一条归属,他从此不能在别人下面新建、也不能被授权。
 *
 * 这两句要是漏了或者写反了,管理员会照着错误的心智模型做人事调整,
 * 而后果要过很久才显形。所以它有测试。
 */

import type { NodeMemberView } from '@knowledgecool/shared';

export function describeRemoval(member: NodeMemberView, nodeTitle: string): string {
  const notes: string[] = [];

  if (member.isOwnerHere) {
    notes.push(
      `他正是「${nodeTitle}」的所有者 —— 移出归属**不会**改变这一点,他仍然能改、能管这里。`,
    );
  } else if (member.isAncestorOwner) {
    notes.push('他是上级所有者 —— 移出归属不影响他对这里的管理权。');
  }

  const isLastAssignment = member.otherPaths.length === 0 && member.memberNodeIds.length === 1;
  if (isLastAssignment) {
    notes.push(
      '这是他唯一的组织归属 —— 移出后他将不属于任何部门 / 组(不能再在别人下面新建,也不能被授权)。',
    );
  } else {
    notes.push('他会失去这里的组织范围 —— 能被他授权的人会变少。');
  }

  const lines = [`把 ${member.name}(${member.employeeNo})从「${nodeTitle}」移出?`];
  if (notes.length > 0) lines.push('', ...notes.map((note) => `· ${note}`));
  return lines.join('\n');
}
