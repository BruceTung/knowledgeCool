import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, FullScreenNote, TextField } from '../components/ui';
import { useChangePassword, useMe, useSetInitialPassword } from '../features/auth/queries';
import { useSetupStore } from '../features/auth/setup-store';

/**
 * 改密页 —— **一页两用,但两条路径的身份依据完全不同**。
 *
 * | | 首次改密 | 已登录主动改密 |
 * |---|---|---|
 * | 触发 | 登录返回 `password-change-required` | 顶栏「改密」 |
 * | 身份依据 | 一次性 `setupToken`(10 分钟) | 会话 |
 * | 要原密码吗 | **不要** | 要 |
 * | 改完之后 | **回登录页**,用新密码重登 | 留在系统里 |
 *
 * ⚠️ v2.4 重做了首次改密这一半。旧版两条路径共用一个表单、一个接口,于是:
 *   - 首次改密也要输原密码(明明刚在登录页输过一次)
 *   - 改完直接进系统,用户**回不到登录页**(那个状态既不是登录也不是未登录)
 *
 * 用户的原话:「重置密码,不需要输入原密码,直接输入新密码」+
 * 「用户在初次登录页面以后,无法回到 login 页面,必须改密码才行,这样是不合适的,
 * 用户第一次登录,不应该记录登录状态,重置完密码以后,应该要用户重新登录才对」。
 *
 * 根因不在这一页,在服务端:**首次登录当时建立了会话**。现在不建立了
 * (见 `LoginResponse`),这一页才可能干净地分成两条路径。
 */
export function ChangePasswordPage() {
  const me = useMe();
  const pending = useSetupStore((state) => state.pending);
  const clearSetup = useSetupStore((state) => state.clear);
  const navigate = useNavigate();

  const setInitial = useSetInitialPassword();
  const change = useChangePassword();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  /**
   * 首次改密已完成。
   *
   * 它决定**兜底跳转要不要带提示** —— 见下面那个 `<Navigate>` 的注释。
   * 本地 state 而不是全局 store:组件一卸载它就没了,不会把"刚改完"
   * 这个一次性的事实留给下一次访问。
   */
  const [changed, setChanged] = useState(false);

  /** 有一次性凭证 = 首次改密。这是这一页唯一的模式判据。 */
  const isFirstTime = pending !== null;

  const mismatch = confirm !== '' && confirm !== newPassword;
  const busy = isFirstTime ? setInitial.isPending : change.isPending;
  const error = isFirstTime ? setInitial.error : change.error;

  // 既没有凭证、又没登录 —— 回登录页。
  // (刷新页面会丢掉凭证,这是**预期**的降级,不是故障。)
  //
  // ⚠️ 顺带承担了"首次改密成功后"的跳转:那时凭证被清掉、会话又不存在,
  // 于是自然落到这里。**提示必须挂在这条路径上** ——
  // 否则用户被送回登录页却不知道刚才那步成没成(实测踩过)。
  if (!isFirstTime && changed) {
    return <Navigate to="/login" replace state={{ passwordChanged: true }} />;
  }
  if (!isFirstTime && me.isPending) return <FullScreenNote>正在检查登录状态…</FullScreenNote>;
  if (!isFirstTime && me.isError) return <Navigate to="/login" replace />;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;

    if (pending !== null) {
      setInitial.mutate(
        { setupToken: pending.setupToken, newPassword },
        {
          onSuccess: () => {
            // 服务端**不会**给会话。所以这里不是"进系统",而是:
            // 先标记"改完了",再清掉凭证 —— 两件事做完之后,
            // 本页就变成"既无凭证、也无会话",由上面那个 `<Navigate>`
            // 负责把人送回登录页,**并带上"刚改完"的提示**。
            //
            // ⚠️ 不要在这里自己 navigate:那样会有两条跳转路径,
            // 而先执行的那条未必带 state(实测踩过 —— 提示丢失)。
            setChanged(true);
            clearSetup();
          },
        },
      );
      return;
    }

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
      title={isFirstTime ? '设置你的密码' : '修改密码'}
      subtitle={
        isFirstTime
          ? `${pending.name}(${pending.employeeNo})· 初始密码是统一发放的,先设一个只有你知道的密码`
          : undefined
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/*
          ⚠️ 首次改密**不要当前密码** —— 登录那一步已经用初始密码验证过身份了,
          再要一次只是重复。身份由那张一次性凭证证明。
        */}
        {!isFirstTime && (
          <TextField
            label="当前密码"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
            }}
          />
        )}

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
        <ErrorNote error={error} />

        <Button type="submit" disabled={busy || mismatch} className="w-full py-2">
          {busy ? '提交中…' : isFirstTime ? '设置密码并返回登录' : '确认修改'}
        </Button>
      </form>

      <p className="mt-4 text-sm leading-relaxed text-slate-400">
        {isFirstTime
          ? '设置完成后需要用新密码重新登录一次 —— 这样"这个密码真的能用"是当场验证的,而不是等你下次来才发现打错了。'
          : '改完之后当前会话继续有效,不用重新登录。'}
      </p>

      {/*
        ⚠️ 必须有一条退路。
        用户明确反馈过:「用户在初次登录页面以后,无法回到 login 页面,
        必须改密码才行,这样是不合适的」。所以「返回登录页」永远在。
      */}
      <p className="mt-4 text-center text-sm">
        <Link
          to="/login"
          className="text-slate-400 transition-colors hover:text-slate-600"
          onClick={() => {
            // 主动放弃这次改密 → 凭证一并作废,免得再进来还看到旧的那张
            if (isFirstTime) clearSetup();
          }}
        >
          ← 返回登录页
        </Link>
      </p>
    </AuthShell>
  );
}
