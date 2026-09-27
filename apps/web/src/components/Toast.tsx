/**
 * toast 的渲染出口(v2.12)。
 *
 * 挂在 `App` 的根上(见 App.tsx),所以**未登录的页面也能收到提示** ——
 * 登录页的"密码已设置成功""账号被锁定"这类信息正是需要它的地方。
 *
 * 无障碍上有两点是刻意的:
 *   · 容器常驻、`aria-live="polite"`:**先有容器、后有内容**,
 *     屏幕阅读器才会把新加进来的那条读出来。反过来(整块条件渲染)不会播报。
 *   · 错误用 `role="alert"`(打断式),其余用 `role="status"`(礼貌式)——
 *     把"操作成功"做成打断式会很吵。
 */
import { useToastStore, type ToastTone } from '../lib/toast-store';

const TONE_CLASS: Readonly<Record<ToastTone, string>> = {
  info: 'border-slate-200 bg-white text-slate-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-red-200 bg-red-50 text-red-800',
};

export function ToastHost() {
  const items = useToastStore((state) => state.items);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2 text-sm leading-relaxed shadow-lg ${TONE_CLASS[item.tone]}`}
        >
          <span className="min-w-0 flex-1 break-words">{item.message}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => {
              dismiss(item.id);
            }}
            className="-mr-1 flex-none rounded px-1.5 text-base leading-none opacity-60 transition-opacity hover:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
