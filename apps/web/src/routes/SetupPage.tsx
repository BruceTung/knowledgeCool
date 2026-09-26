import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, FullScreenNote, TextField } from '../components/ui';
import { useMe, useSetup, useSetupState } from '../features/auth/queries';

/**
 * 首次初始化引导页(DESIGN.md §7.2 的 `/setup`)。
 *
 * 只有在**库里一个用户都没有**时才应该出现。判断依据是公开接口
 * `GET /auth/setup-state`,而不是「试着提交再接住 403」——
 * 后者会让用户在看到一个正常表单后莫名其妙地被拒绝。
 */
export function SetupPage() {
  const setupState = useSetupState();
  const me = useMe();
  const setup = useSetup();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  if (setupState.isPending) return <FullScreenNote>正在检查系统状态…</FullScreenNote>;

  // 系统已初始化 → 这不是该来的地方
  if (setupState.data?.required === false) {
    return <Navigate to={me.data !== undefined ? '/' : '/login'} replace />;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setup.mutate(
      { email, name, password },
      { onSuccess: () => void navigate('/', { replace: true }) },
    );
  }

  return (
    <AuthShell title="初始化知源知识库" subtitle="首次部署 · 创建第一位管理员">
      <form onSubmit={handleSubmit} className="space-y-4">
        <TextField
          label="企业邮箱"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => void setEmail(e.target.value)}
          placeholder="admin@example.com"
        />
        <TextField
          label="显示名"
          required
          maxLength={64}
          value={name}
          onChange={(e) => void setName(e.target.value)}
          placeholder="你的名字"
        />
        <TextField
          label="密码"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => void setPassword(e.target.value)}
          hint="至少 8 位;上限 72 字节(约 24 个汉字)"
        />

        <ErrorNote error={setup.error} />

        <Button type="submit" disabled={setup.isPending} className="w-full py-2">
          {setup.isPending ? '正在创建…' : '创建管理员并进入'}
        </Button>

        <p className="text-xs leading-relaxed text-slate-400">
          该入口只在系统没有任何用户时可用。创建成功后,库里就存在账号,此页会自动关闭。
        </p>
      </form>
    </AuthShell>
  );
}
