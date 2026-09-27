import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { AuthShell, Button, ErrorNote, FullScreenNote, TextField } from '../components/ui';
import { useLogin, useMe, useSetupState } from '../features/auth/queries';
import { useSetupStore } from '../features/auth/setup-store';
import { ApiError } from '../lib/api';
import { useDocumentTitle } from '../lib/use-document-title';

/**
 * 后端在 RATE_LIMITED 的 details 里给的等待秒数。
 * 不是所有 RATE_LIMITED 都带这个字段,所以取不到就返回 0(只影响倒计时体验)。
 */
function retryAfterOf(error: unknown): number {
  if (!(error instanceof ApiError) || error.code !== 'RATE_LIMITED') return 0;
  const details = error.details as { retryAfterSeconds?: unknown } | undefined;
  const value = details?.retryAfterSeconds;
  return typeof value === 'number' && value > 0 ? Math.ceil(value) : 0;
}

function waitLabel(seconds: number): string {
  if (seconds <= 60) return String(seconds) + ' 秒';
  return String(Math.ceil(seconds / 60)) + ' 分钟';
}

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
  useDocumentTitle('登录');

  const me = useMe();
  const setupState = useSetupState();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const startSetup = useSetupStore((state) => state.start);

  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');
  /**
   * 锁定到期时刻,以及驱动倒计时的"当前时刻"。
   *
   * 两个都在**失败回调里**写入(那是事件上下文,读时钟与 setState 都合法),
   * 而不是在渲染期间读 Date.now()、也不是在 effect 里同步 setState ——
   * 后两种写法会踩本仓库 lint 里的 React Compiler 规则,而且它们确实是真实的坏味道
   * (渲染期读时钟 = 渲染不纯;effect 里同步 setState = 级联渲染)。
   *
   * 时间到之后 lockedSeconds 归零,表单自动恢复可提交,不需要刷新页面。
   */
  const [lockedUntil, setLockedUntil] = useState(0);
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    if (lockedUntil <= 0) return undefined;
    const handle = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(handle);
    };
  }, [lockedUntil]);

  const lockedSeconds =
    lockedUntil > nowMs ? Math.max(0, Math.ceil((lockedUntil - nowMs) / 1000)) : 0;

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
        onError: (error) => {
          // 被锁了就起算倒计时。放在这里而不是从 query 的 error 派生:
          // 这样"再次被锁"能重新起算,也不必在渲染期读时钟。
          const seconds = retryAfterOf(error);
          if (seconds <= 0) return;
          const now = Date.now();
          setLockedUntil(now + seconds * 1000);
          setNowMs(now);
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

        {lockedSeconds > 0 ? (
          <p
            role="status"
            className="rounded-md bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800"
          >
            {'登录尝试次数过多,已临时锁定。请 ' +
              waitLabel(lockedSeconds) +
              ' 后再试。若忘记密码,请联系管理员重置。'}
          </p>
        ) : (
          <ErrorNote error={login.error} />
        )}

        <Button
          type="submit"
          disabled={login.isPending || lockedSeconds > 0}
          className="w-full py-2"
        >
          {lockedSeconds > 0 ? '已锁定(' + waitLabel(lockedSeconds) + ')' : login.isPending ? '登录中…' : '登录'}
        </Button>
      </form>

      {/* 刻意**不**在这里写出初始密码。它虽然人人皆知,但登录页是未认证访问者
          也能看到的地方 —— 把默认口令印在最显眼的页面上,等于替一次横向撞库
          省掉了全部信息收集成本。改成"由管理员告知",谁需要知道谁去问。 */}
      <p className="mt-6 text-sm leading-relaxed text-slate-500">
        账号由管理员通过组织架构导入统一预置,不需要自行注册。
        <br />
        初始密码由管理员告知。首次登录必须先设置自己的新密码,再用新密码登录一次。
      </p>
    </AuthShell>
  );
}
