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
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

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

  /*
    ---- 焦点:打开时移进来,关闭时还回去 ----

    ⚠️⚠️ v4.9:两处都修过。

    **① opener 必须在"第一次渲染时"捕获,不能在 effect 里读。**
    `document.activeElement` 在 effect 执行时可能**已经不是**打开弹窗的那个元素了:
    React 会在 **commit 阶段**应用子元素的 `autoFocus`,而 effect 是之后才跑的。
    于是 `opener` 会变成"弹窗**里面**那个 autoFocus 的元素"——
    关闭时 `document.contains(opener)` 判定通过(它确实还在文档里,如果面板还没卸载),
    但它已经是要被移除的节点,焦点还原就落到一个消失了的东西上,等于没还原。

    用 `useRef` + 在**渲染期**赋值(而不是 effect):渲染期读到的
    `document.activeElement` 一定还是"打开之前"的那个元素。

    **② 进入焦点优先取"第一个有意义的元素",而不是 DOM 顺序第一个。**
    原来选的是 `querySelector(FOCUSABLE_SELECTOR)`,而**带头部的对话框
    第一个可聚焦元素是右上角的「关闭」按钮** —— 于是每次打开弹窗,
    键盘用户的第一落点都是"关闭",而不是内容本身。这对一个表单类弹窗
    是明显错的:用户按 Tab 想填第一个字段,却先绕过了关闭按钮。

    现在:优先聚焦 `[data-autofocus]`,其次取**正文区**里的第一个可聚焦元素,
    最后才退回整个面板里的第一个(以及面板本身)。
  */
  /*
    `useState` 的**初始化函数**在组件第一次渲染时执行,而那时
    `document.activeElement` 一定还是"打开弹窗的那个元素" ——
    React 要到 commit 阶段才会应用子元素的 `autoFocus`。

    ⚠️ 不能用 `useRef` + 渲染期赋值:那也是"在渲染期间访问 ref",
    eslint 的 react-hooks/refs 会直接报错,而且它说的对 ——
    渲染期读 ref 在并发渲染下本来就不安全。
    `useState` 的初始化函数是被允许的那条路,而且语义正好:
    "这个值在本次组件生命周期内**只算一次**,之后不再变"。
  */
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    return () => {
      // 还焦点是必须的:用键盘的人关掉弹窗后,焦点若停在 body 上,
      // 他按 Tab 会从页面最开头重新走一遍。
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;

    // ① 显式指定优先
    const explicit = panel.querySelector<HTMLElement>('[data-autofocus]');
    if (explicit !== null) {
      explicit.focus();
      return;
    }
    // ② 正文区内的第一个(跳过头部那个「关闭」按钮)
    const body = panel.querySelector<HTMLElement>('[data-modal-body]');
    const inBody = body?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (inBody !== undefined && inBody !== null) {
      inBody.focus();
      return;
    }
    // ③ 退路:整块面板里的第一个,再不行就聚焦面板本身(它有 tabIndex={-1})
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

  /*
    ---- 锁背景滚动 ----

    ⚠️⚠️ v4.12:改锁**真正的滚动容器**,并且**按 CSS 判定**,不按"此刻能不能滚"。

    这个应用的布局是 `html, body, #root { height: 100% }`(styles.css),
    真正滚动的是 `<main class="overflow-auto">`(AppLayout)。所以:

    · **原来锁 `document.body.style.overflow`** —— `body` 根本滚不动,
      锁的是一个永远不会滚动的东西。表现:**对话框开着、背后照样能滚**。
    · **上一版(v4.9)改为"扫所有 scrollHeight > clientHeight 的容器"** ——
      这条判据是错的:**内容不够长时 `scrollHeight === clientHeight`**,
      于是 `<main>` 直接被漏掉,兜底又把 `body` 锁了(等于回到原样)。
      真机实测就是这么翻车的:打开对话框后 `<main>` 的 overflow 仍是 `''`。

    现在改成**给 `<body>` 打一个标记类**,由 CSS 去锁 `main`
    (见 `styles.css` 的 `body[data-kc-modal-open]` 规则):
      · 只看 CSS 的 `overflow`,不看当前内容够不够长 —— 与"此刻能不能滚"无关;
      · 不碰任何 `ref`,也就绕开了 react-hooks/immutability 那条
        (它禁止"修改通过 ref 拿到的值",而这本来就是别的组件的节点);
      · 布局真变了(比如以后 `main` 改名)只需要改一条 CSS,
        不必再在组件里维护一套 DOM 遍历。

    ⚠️ 用**计数**而不是布尔:对话框可以叠加(成员弹窗里再开权限弹窗),
    用布尔的话第一个关闭时就把锁解了,而上面那个还开着。
  */
  useEffect(() => {
    const body = document.body;
    const next = Number(body.dataset.kcModalCount ?? '0') + 1;
    body.dataset.kcModalCount = String(next);
    body.dataset.kcModalOpen = 'true';

    return () => {
      const left = Number(body.dataset.kcModalCount ?? '1') - 1;
      if (left <= 0) {
        delete body.dataset.kcModalOpen;
        delete body.dataset.kcModalCount;
      } else {
        body.dataset.kcModalCount = String(left);
      }
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

        <div
          data-modal-body
          className={bodyClassName ?? `${bodyMaxHeightClass} space-y-5 overflow-auto px-5 py-4`}
        >
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
