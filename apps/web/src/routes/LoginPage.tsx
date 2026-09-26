import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, FullScreenNote, TextField } from '../components/ui';
import { useLogin, useMe, useSetupState } from '../features/auth/queries';

/**
 * 登录页(DESIGN.md §7.2 的 `/login`)。
 *
 * 错误提示直接沿用后端的「邮箱或密码不正确」—— §6.1 刻意不区分
 * 「邮箱不存在」与「密码错误」,前端不能自作聪明地补一句
 * 「该邮箱尚未注册」,那等于把后端堵上的账号枚举口子又捅开。
 */
export function LoginPage() {
  const me = useMe();
  const setupState = useSetupState();
  const login = useLogin();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (me.isPending || setupState.isPending) {
    return <FullScreenNote>正在检查登录状态…</FullScreenNote>;
  }

  if (me.data !== undefined) return <Navigate to="/" replace />;
  if (setupState.data?.required === true) return <Navigate to="/setup" replace />;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => void navigate('/', { replace: true }) });
  }

  return (
    <AuthShell title="登录知源知识库" subtitle="内网自托管 · 企业内部知识库">
      <form onSubmit={handleSubmit} className="space-y-4">
        <TextField
          label="企业邮箱"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => void setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <TextField
          label="密码"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => void setPassword(e.target.value)}
        />

        <ErrorNote error={login.error} />

        <Button type="submit" disabled={login.isPending} className="w-full py-2">
          {login.isPending ? '登录中…' : '登录'}
        </Button>
      </form>

      <p className="mt-6 text-xs text-slate-400">
        还没有账号?阶段一的账号由空间管理员在「成员管理」里创建。
        <br />
        <Link to="/setup" className="text-slate-500 underline hover:text-slate-700">
          系统尚未初始化?
        </Link>
      </p>
    </AuthShell>
  );
}
