import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, FullScreenNote, TextField } from '../components/ui';
import { useMe, useSetup, useSetupState } from '../features/auth/queries';

/**
 * 首次部署的管理员初始化(DESIGN.md §7.2 的 `/setup`)。
 *
 * 只在**库中一个用户都没有**时可用 —— 服务端用"无用户才允许"这条规则保证,
 * 前端这个判断只是为了不让用户在明知不可用时白填一遍表单。
 *
 * 这里建的账号 `mustChangePassword` 是 `false`:初始密码是他自己当场设的,
 * 再强制他改一遍没有意义。
 */
export function SetupPage() {
  const me = useMe();
  const setupState = useSetupState();
  const setup = useSetup();
  const navigate = useNavigate();

  const [employeeNo, setEmployeeNo] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  if (me.isPending || setupState.isPending) {
    return <FullScreenNote>正在检查系统状态…</FullScreenNote>;
  }

  if (me.data !== undefined) return <Navigate to="/" replace />;
  if (setupState.data?.required === false) return <Navigate to="/login" replace />;

  const mismatch = confirm !== '' && confirm !== password;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setup.mutate(
      { employeeNo: employeeNo.trim(), name: name.trim(), password },
      { onSuccess: () => void navigate('/', { replace: true }) },
    );
  }

  return (
    <AuthShell title="初始化知源知识库" subtitle="库里还没有任何账号,先创建第一个管理员">
      <form onSubmit={handleSubmit} className="space-y-4">
        <TextField
          label="工号"
          required
          value={employeeNo}
          onChange={(event) => {
            setEmployeeNo(event.target.value);
          }}
          hint="登录用的就是工号,定下来之后不要改 —— 改了系统会当成另一个人。"
          placeholder="例如 admin"
        />
        <TextField
          label="姓名"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextField
          label="密码"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          hint="至少 8 位,且同时包含字母与数字。"
        />
        <TextField
          label="确认密码"
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
            两次输入的密码不一致。
          </p>
        )}
        <ErrorNote error={setup.error} />

        <Button type="submit" disabled={setup.isPending || mismatch} className="w-full py-2">
          {setup.isPending ? '创建中…' : '创建管理员并进入'}
        </Button>
      </form>

      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        这个账号会成为超级管理员,负责建部门、导人员名单、任命各级所有者。
      </p>
    </AuthShell>
  );
}
