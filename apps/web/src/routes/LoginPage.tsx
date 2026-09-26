import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, FullScreenNote, TextField } from '../components/ui';
import { useLogin, useMe, useSetupState } from '../features/auth/queries';

/**
 * 登录页(DESIGN.md §7.2 的 `/login`)。
 *
 * ⚠️ **v2.2 起用工号登录,不是邮箱。**
 *
 * 错误提示直接沿用后端的文案 —— §6.1 刻意不区分「工号不存在」与「密码错误」,
 * 前端不能自作聪明地补一句「该工号尚未注册」,那等于把后端堵上的
 * 账号枚举口子又捅开。
 */
export function LoginPage() {
  const me = useMe();
  const setupState = useSetupState();
  const login = useLogin();
  const navigate = useNavigate();

  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');

  if (me.isPending || setupState.isPending) {
    return <FullScreenNote>正在检查登录状态…</FullScreenNote>;
  }

  if (me.data !== undefined) return <Navigate to="/" replace />;
  if (setupState.data?.required === true) return <Navigate to="/setup" replace />;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate(
      { employeeNo: employeeNo.trim(), password },
      { onSuccess: () => void navigate('/', { replace: true }) },
    );
  }

  return (
    <AuthShell title="登录知源知识库" subtitle="内网自托管 · 企业内部知识库">
      <form onSubmit={handleSubmit} className="space-y-4">
        <TextField
          label="工号"
          autoComplete="username"
          required
          value={employeeNo}
          onChange={(event) => {
            setEmployeeNo(event.target.value);
          }}
          placeholder="例如 KC2026001"
        />
        <TextField
          label="密码"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />

        <ErrorNote error={login.error} />

        <Button type="submit" disabled={login.isPending} className="w-full py-2">
          {login.isPending ? '登录中…' : '登录'}
        </Button>
      </form>

      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        账号由管理员通过组织架构导入统一预置,不需要自行注册。
        <br />
        首次登录的初始密码是 <code className="rounded bg-slate-100 px-1">123456</code>,
        登录后会被要求改成自己的密码。
      </p>
    </AuthShell>
  );
}
