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
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50';

export function TextField({
  label,
  hint,
  ...rest
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-slate-600">{label}</span>
      <input {...rest} className={INPUT_CLASS} />
      {hint !== undefined && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
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
 * 直接用后端的 message —— §6.1 已保证它是**给人看的中文**,
 * 而且刻意不区分「不存在」与「无权访问」。前端不做二次包装,
 * 免得把后端精心设计的措辞又改回成能被枚举的信息。
 */
export function ErrorNote({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message =
    error instanceof ApiError || error instanceof Error ? error.message : '发生未知错误';
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  );
}

export function FullScreenNote({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 p-8">
      <p className="text-sm text-slate-500">{children}</p>
    </main>
  );
}
