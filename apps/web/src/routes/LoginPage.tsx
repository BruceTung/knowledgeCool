import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, FullScreenNote, TextField } from '../components/ui';
import { useLogin, useMe, useSetupState } from '../features/auth/queries';
import { useSetupStore } from '../features/auth/setup-store';

/**
 * 登录页(DESIGN.md §7.2 的 `/login`)。
 *
 * ⚠️ **v2.2 起用工号登录,不是邮箱。**
 *
 * ⚠️ **v2.4 起登录有两种结果**(见 `LoginResponse`):
 *   - 常规 → 建立会话,直接进工作台
 *   - 首次登录 → **不建立会话**,只拿一张 10 分钟的一次性凭证去改密页;
 *     改完必须用新密码重新登录一次
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
  const location = useLocation();
  const startSetup = useSetupStore((state) => state.start);

  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');

  // 刚从改密页跳回来 —— 必须明说"用新密码登一次",
  // 否则用户会以为"我改完了怎么又要登,是不是没成功"。
  const justChanged =
    (location.state as { passwordChanged?: boolean } | null)?.passwordChanged === true;

  if (me.isPending || setupState.isPending) {
    return <FullScreenNote>正在检查登录状态…</FullScreenNote>;
  }

  if (me.data !== undefined) return <Navigate to="/" replace />;
  if (setupState.data?.required === true) return <Navigate to="/setup" replace />;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate(
      { employeeNo: employeeNo.trim(), password },
      {
        onSuccess: (result) => {
          // 首次登录:服务端**没有**写 Cookie,只给了一张一次性凭证。
          // 凭证只放内存(zustand),刷新就没了 —— 那时回登录页重来一次即可,
          // 这比把它落到浏览器存储里等 XSS 来拿划算。
          if (result.kind === 'password-change-required') {
            startSetup({
              employeeNo: result.employeeNo,
              name: result.name,
              setupToken: result.setupToken,
              expiresAt: result.setupTokenExpiresAt,
            });
            void navigate('/change-password', { replace: true });
            return;
          }
          void navigate('/', { replace: true });
        },
      },
    );
  }

  return (
    <AuthShell title="登录知源知识库" subtitle="内网自托管 · 企业内部知识库">
      {justChanged && (
        <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm leading-relaxed text-emerald-800">
          密码已设置成功。<b>请用新密码登录</b> —— 首次登录不会直接进系统。
        </p>
      )}

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

      <p className="mt-6 text-sm leading-relaxed text-slate-400">
        账号由管理员通过组织架构导入统一预置,不需要自行注册。
        <br />
        首次登录的初始密码是 <code className="rounded bg-slate-100 px-1">123456</code>,
        登录后先设一个新密码,再用新密码登录一次。
      </p>
    </AuthShell>
  );
}
