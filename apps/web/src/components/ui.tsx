/**
 * 共用 UI 原语。
 *
 * 刻意只放「三个以上地方会用」的东西 —— 组件抽象过早比重复更贵。
 * 这里目前只有:居中卡片外壳、表单控件、错误提示、头像配色。
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

import { ApiError } from '../lib/api';

/**
 * 头像 / 空间标识的配色。
 *
 * 键必须与 shared 的 AVATAR_COLORS 一致 —— 服务端用那个白名单校验,
 * 所以这里不可能收到意外值;`?? gray` 只是防御性兜底。
 * 写成字面量字符串而不是拼模板,否则 Tailwind 的扫描器认不出来。
 */
const AVATAR_CLASS: Readonly<Record<string, string>> = {
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  purple: 'bg-violet-50 text-violet-700 ring-violet-200',
  pink: 'bg-pink-50 text-pink-700 ring-pink-200',
  gray: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function avatarClass(color: string): string {
  return AVATAR_CLASS[color] ?? AVATAR_CLASS['gray']!;
}

/** 居中卡片外壳。登录页、引导页、空状态共用。 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 p-8">
      <section className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-blue-50 text-sm font-medium text-blue-700 ring-1 ring-blue-200">
            知
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
            {subtitle !== undefined && <p className="text-sm text-slate-500">{subtitle}</p>}
          </div>
        </div>
        <div className="mt-6">{children}</div>
      </section>
    </main>
  );
}

const INPUT_CLASS =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50';

export function TextField({
  label,
  hint,
  ...rest
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-slate-600">{label}</span>
      <input {...rest} className={INPUT_CLASS} />
      {hint !== undefined && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function SelectField({
  label,
  children,
  ...rest
}: { label?: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const select = (
    <select {...rest} className={INPUT_CLASS}>
      {children}
    </select>
  );
  if (label === undefined) return select;
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-slate-600">{label}</span>
      {select}
    </label>
  );
}

/**
 * 按钮。
 *
 * `className` 会被**合并**而不是被覆盖 —— 第一版把它和 `{...rest}` 一起展开,
 * 结果调用方传的 className 被后面的 className 顶掉(JSX 里后写的胜出),
 * 表现为"加了 flex-none 却没生效",而且在 flex 行里被挤成两行。
 */
export function Button({
  variant = 'primary',
  className,
  children,
  ...rest
}: { variant?: 'primary' | 'secondary' | 'danger' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    'inline-flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const styles: Record<string, string> = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800',
    secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50',
  };
  return (
    <button {...rest} className={`${base} ${styles[variant] ?? ''} ${className ?? ''}`}>
      {children}
    </button>
  );
}

/**
 * 错误提示。
 *
 * `ApiError` 直接用后端的 message —— §6.1 已保证它是**给人看的中文**,
 * 而且刻意不区分「不存在」与「无权访问」。前端不做二次包装,
 * 免得把后端精心设计的措辞又改回成能被枚举的信息。
 *
 * ⚠️⚠️ v4.42:**不是 `ApiError` 的时候,绝不能把 `error.message` 直接摆出来。**
 *
 * 原来这里写的是 `error instanceof ApiError || error instanceof Error ? error.message : …`
 * —— 那个 `|| Error` 分支把**浏览器的原始英文报错**放到了界面上。
 * 实测(断掉 API 后用 CDP 拦截 `/api/v1/*`,刷新首页):
 *
 *     无法连接到服务
 *     Failed to fetch          ← fetch() 被拒时浏览器给的原文
 *
 * 两层问题:
 *   1. **是英文**。这是一个中文产品,把 `Failed to fetch` 摆给用户看。
 *   2. **没说该怎么办**。网络断了/服务挂了,用户需要知道「稍后再试」,
 *      而不是一个他看不懂、也无从下手的字符串。
 *
 * 所以只有**来自后端**的 `ApiError` 才用它自己的措辞;
 * 其余(网络失败、解析失败、未知异常)统一收敛成一句中文,
 * 并给出「检查网络或稍后重试」这个可执行的下一步。
 */
export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error === null || error === undefined) return null;
  const message =
    error instanceof ApiError ? error.message : '请求没有送达服务器。请检查网络,或稍后重试。';
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry !== undefined && (
        <button
          type="button"
          className="flex-none rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 transition-colors hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:outline-none"
          onClick={onRetry}
        >
          重试
        </button>
      )}
    </div>
  );
}

/**
 * 骨架屏(v2.14)。
 *
 * 原本各处都是「加载中…」这五个字。它有两个问题:
 *   1. **布局会跳** —— 一秒前是一个居中的短句,一秒后是一整页内容,视线要重新找位置;
 *   2. 它不告诉你**将要出现什么**。骨架屏至少给出"这里会有一张表 / 一段正文"。
 *
 * 用 animate-pulse(Tailwind 内置)而不是自己写动画 —— 它在
 * prefers-reduced-motion 下会被浏览器降级,不需要额外处理。
 *
 * aria-hidden + 外层 role="status":屏幕阅读器不该去念一堆空方块,
 * 它只要知道"正在加载"就够了。
 */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-label="加载中" className={className ?? ''}>
      <div className="animate-pulse space-y-2" aria-hidden>
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className="h-4 rounded bg-slate-200"
            style={index === lines - 1 && lines > 1 ? { width: '60%' } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export function FullScreenNote({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 p-8">
      <p className="text-sm text-slate-500">{children}</p>
    </main>
  );
}
