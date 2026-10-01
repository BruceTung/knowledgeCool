/**
 * 模态对话框原语(v2.12 新增)。
 *
 * ## 为什么必须有它
 *
 * 在此之前全站有**三套手写模态**(命令面板 / 授权弹窗 / 成员弹窗),
 * 而它们都有一个共同的毛病:不过是一个 `fixed inset-0` 的 div。具体后果:
 *
 *   · 没有 `role="dialog"` / `aria-modal` —— 屏幕阅读器不知道弹出了对话框,
 *     会把背后的整页内容一起读出来(违反 1.3.1 / 4.1.2)
 *   · 打开时**不移动焦点**(焦点还留在 body 上),按 Tab 会直接走到**背后的页面**(2.4.3)
 *   · 没有焦点陷阱 —— 焦点绕到页面底部再转回来
 *   · 只有命令面板处理了 Esc,授权/成员弹窗**完全不响应 Esc**(2.1.2)
 *   · 不锁背景滚动 —— 弹窗开着还能把背后的页面滚走
 *   · 关闭**不归还焦点** —— 用键盘的人关掉之后不知道自己在哪
 *
 * 这些都不是"体验优化",是 WCAG。收敛成一个原语之后,新加的模态不可能再漏掉其中任何一条。
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Button } from './ui';

/** 可聚焦元素的选取范围。disabled 的一律排除 —— 它们本来也 Tab 不到。 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface ModalCommonProps {
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClass?: string;
  /** 面板 body 的最大高度。成员/授权弹窗内容长,命令面板要矮一些。 */
  bodyMaxHeightClass?: string;
  /** 少数场景需要点在遮罩上不关闭(例如正在提交)。 */
  closeOnBackdrop?: boolean;
  /** 覆盖 body 的默认类。命令面板需要"输入框不滚、结果区自己滚"。 */
  bodyClassName?: string;
}

/**
 * 表头有两种形态,**用类型把它们钉死**:
 *   · 默认 —— 必须有 `title`,`aria-labelledby` 指向它
 *   · `hideHeader` —— 必须给 `ariaLabel`,否则这个对话框就没有可访问名
 *
 * 这样"忘了给可访问名"在**编译期**就过不去,而不是等到无障碍审计才发现。
 * (命令面板就是第二种:它的第一行是搜索框,不该再压一条标题栏。)
 */
export type ModalProps = ModalCommonProps &
  (
    | { hideHeader: true; ariaLabel: string; title?: never }
    | { hideHeader?: false; title: ReactNode; ariaLabel?: string }
  );

export function Modal(props: ModalProps) {
  const {
    onClose,
    children,
    footer,
    maxWidthClass = 'max-w-2xl',
    bodyMaxHeightClass = 'max-h-[70vh]',
    closeOnBackdrop = true,
    bodyClassName,
  } = props;

  const hideHeader = props.hideHeader === true;
  const title = hideHeader ? null : props.title;
  const ariaLabel = props.ariaLabel;

  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // ---- 焦点:打开时移进来,关闭时还回去 ----
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      // 还焦点是必须的:用键盘的人关掉弹窗后,焦点若停在 body 上,
      // 他按 Tab 会从页面最开头重新走一遍。
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    // 优先聚焦第一个可聚焦元素;没有的话聚焦面板本身(它有 tabIndex={-1})。
    const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? panel).focus();
  }, []);

  // ---- Esc 关闭 + 焦点陷阱 ----
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // 用捕获阶段:编辑器里的链接气泡、表格菜单也会监听 Esc,
        // 这里只要保证"弹窗开着时 Esc 一定关得掉"。
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;

      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  // ---- 锁背景滚动 ----
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-slate-900/20 p-6 pt-16">
      <div
        className="absolute inset-0"
        role="presentation"
        onClick={closeOnBackdrop ? onClose : undefined}
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hideHeader ? undefined : titleId}
        aria-label={hideHeader ? ariaLabel : undefined}
        tabIndex={-1}
        className={`relative w-full ${maxWidthClass} rounded-xl border border-slate-200 bg-white shadow-2xl outline-none`}
      >
        {!hideHeader && (
          <header className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
              {title}
            </h2>
            <Button variant="secondary" className="flex-none" onClick={onClose}>
              关闭
            </Button>
          </header>
        )}

        <div className={bodyClassName ?? `${bodyMaxHeightClass} space-y-5 overflow-auto px-5 py-4`}>
          {children}
        </div>

        {footer !== undefined && (
          <footer className="flex items-center gap-2 border-t border-slate-200 px-5 py-3">
            {footer}
          </footer>
        )}
      </section>
    </div>
  );
}
