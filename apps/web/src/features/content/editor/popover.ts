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
  // 后者塞不进 JSX 的 `ref`,会报 not assignable to Ref。
  const ref = useRef<HTMLDivElement>(null);

  /*
    ⚠️ v4.34:`onClose` 放进 ref,**不进依赖数组**。

    原来是 `}, [active, onClose]);`。问题在于**两个调用方传的都是每次渲染都会变的新函数**:
      · `LinkPopover`:`function closePopover(){}` —— 函数声明,每次渲染都是新身份;
      · `TableMenu`:`() => { setOpen(false); }` —— 内联箭头,同理。
    于是浮层开着的时候,**每一次渲染都会先移除、再重新挂上 document 级监听**。
    打字时每敲一个字符就渲染一次,也就是每敲一下都重挂。

    这不只是「多几次调用」的问题:`removeEventListener` 与 `addEventListener` 之间
    存在一个**瞬间的窗口**,那一刻监听不在。事件恰好落在这个窗口里就会丢 ——
    表现是「点了外面没关掉」这种偶发,而且无法稳定复现。

    修法是 React 的标准「latest ref」:handler 每次渲染更新进 ref,挂在 document 上的
    那个闭包**只读 ref**,于是它永远是最新的,而 effect 只需要在 `active` 变化时跑。
    这样监听的生命周期就与「开/关」一致,而不是与「渲染次数」一致。
  */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;

    function onPointerDown(event: PointerEvent): void {
      const node = ref.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        onCloseRef.current();
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCloseRef.current();
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);

  return ref;
}
