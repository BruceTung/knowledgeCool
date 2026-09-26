/**
 * 重置密码的确认文案(v2.5)。
 *
 * 与 `features/members/removal-note.ts` 同一个理由:"重置密码"这四个字
 * **完全没有说**它会把人踢下线。管理员点下去之前应该知道自己在做什么 ——
 * 这段话就是他的唯一依据,所以它属于要被测试钉住的东西,而不是随手写在 JSX 里。
 *
 * ⚠️ **这是 `window.confirm` 的纯文本,不是 Markdown。** 别写 `**加粗**` ——
 * 它会把两个星号原样显示出来(实渲染验证时抓到的)。要强调就用「」。
 */
import type { OrgUserView } from '@knowledgecool/shared';

/** 初始密码。与 shared 的 `INITIAL_PASSWORD` 同值,这里只用于文案。 */
const INITIAL_PASSWORD_LABEL = '123456';

export function describeReset(user: OrgUserView): string {
  const lines = [
    `把 ${user.name}(${user.employeeNo})的密码重置为初始密码 ${INITIAL_PASSWORD_LABEL}?`,
    '',
    '· 他下次登录会被要求先改成自己的密码(8 位以上,含字母与数字)',
    '· 他当前的所有登录会「立刻失效」—— 正在编辑但没保存的内容会丢',
    '· 这次操作会记进审计日志',
  ];

  // 对他自己来说这条信息有用:他可能以为"重置一下就能恢复访问",
  // 而实际上他的密码本来就是 123456 —— 重置只是把他又踢了一次。
  // 真正要查的是"为什么他登不上"(状态是不是已离职/停用)。
  if (user.mustChangePassword) {
    lines.push('', '· 注意:他的密码本来就是初始值,重置只是又踢了他一次');
  }

  return lines.join('\n');
}
