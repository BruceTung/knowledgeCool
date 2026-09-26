import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, TextField } from '../components/ui';
import { useChangePassword, useMe } from '../features/auth/queries';

/**
 * 修改密码(DESIGN.md §6.1.2 的 `/change-password`)。
 *
 * 两个入口共用这一页:首次登录被强制改密、以及用户主动来改。
 * **不区分两个页面** —— 表单完全一样,唯一差别是文案。
 *
 * ⚠️ 安全边界不在这里。即便有人绕过这一页直接调别的接口,服务端守卫会
 * 一律回 403 `PASSWORD_CHANGE_REQUIRED`。这一页的作用是"别让人看到
 * 一个满屏报错的界面",不是拦截。
 */
export function ChangePasswordPage() {
  const me = useMe();
  const change = useChangePassword();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const forced = me.data?.user.mustChangePassword === true;
  const mismatch = confirm !== '' && confirm !== newPassword;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    change.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setCurrentPassword('');
          setNewPassword('');
          setConfirm('');
          void navigate('/', { replace: true });
        },
      },
    );
  }

  return (
    <AuthShell
      title={forced ? '请先修改初始密码' : '修改密码'}
      subtitle={
        forced ? '初始密码是统一发放的,改成只有你知道的密码才能继续使用' : undefined
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <TextField
          label="当前密码"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => {
            setCurrentPassword(event.target.value);
          }}
          {...(forced ? { hint: '初始密码是 123456' } : {})}
        />
        <TextField
          label="新密码"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => {
            setNewPassword(event.target.value);
          }}
          hint="至少 8 位,且必须同时包含字母与数字。"
        />
        <TextField
          label="确认新密码"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
          }}
        />

        {mismatch && (
          <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            两次输入的新密码不一致。
          </p>
        )}
        <ErrorNote error={change.error} />

        <Button type="submit" disabled={change.isPending || mismatch} className="w-full py-2">
          {change.isPending ? '提交中…' : '确认修改'}
        </Button>
      </form>
    </AuthShell>
  );
}
