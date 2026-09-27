/**
 * 浮层(下拉/气泡)的共用零件。
 *
 * 三个浮层(链接、表格菜单、语言下拉)都需要同样的两件事:
 *   1. 点浮层外面 → 关掉
 *   2. 按 Esc → 关掉
 * 各写一份一定会漂移(实测:`window.prompt` 那版连"外面"都没有),
 * 所以抽成一个钩子。
 *
 * ⚠️ 监听用**捕获阶段**(`capture: true`):
 * 编辑器会吞掉不少事件,不捕获的话"点正文关不掉浮层"。
 * 这里刻意**不** `stopPropagation` —— 让编辑器照常收到事件,
 * 否则点击正文时光标不会落下去,用户得再点一次。
 */
import { useEffect, useRef, type RefObject } from 'react';

/**
 * 浮层的统一外观。
 *
 * ⚠️ **不带左右对齐** —— 对齐由调用方给(`left-0` 或 `right-0`),因为两者同时写会
 * 让浮层被拉宽到两端。实测:表格菜单的触发按钮落在工具栏中段,用 `left-0` 展开时
 * 右边缘会越过正文列压到右栏上,看起来像出了 bug;改成 `right-0` 之后就整体
 * 留在正文列内。正文列在这个布局里只有 400 多 px,这一条不是洁癖。
 */
export const POPOVER_CLASS =
  'absolute top-full z-30 mt-1 rounded-lg border border-slate-200 bg-white p-3 shadow-lg';

export function useDismiss(active: boolean, onClose: () => void): RefObject<HTMLDivElement> {
  // React 18 的类型:`useRef<T>(null)` 给 `RefObject<T>`(`current` 允许为 null),
  // 而 `useRef<T | null>(null)` 给的是 `MutableRefObject<T | null>` ——
  // 后者塞不进 JSX 的 `ref`,会报 "not assignable to Ref"。
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;

    function onPointerDown(event: PointerEvent): void {
      const node = ref.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        onClose();
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, onClose]);

  return ref;
}
