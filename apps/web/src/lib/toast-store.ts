/**
 * 轻量提示(toast,v2.12 新增)。
 *
 * ## 为什么要有它
 *
 * 在此之前全站**没有 toast** —— 后果是双重的:
 *   1. **成功操作没有任何确认**。管理员点了「重置密码」,页面只是列表变了一下,
 *      他不确定到底成没成。
 *   2. 信息与错误只能挤在某个角落,于是有 **10 处**用了阻塞式的
 *      `window.confirm` / `alert` —— 连"没有需要清理的东西"这种信息也用 alert 弹。
 *
 * ## 为什么用 zustand 而不是 Context
 *
 * 要弹提示的地方不都在 React 组件里:mutation 的 `onSuccess` 回调、
 * store 的动作、甚至普通函数。Context 要求有个 hook 调用点,
 * 而那些地方没有。zustand 的 `getState()` 在组件外也能用(见 `toast()`)。
 */

import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

/**
 * 自动消失的时间。**错误留久一点** —— 它通常需要读两遍,
 * 而且"没看清就消失了"对错误提示来说等于没提示。
 */
const TTL_MS: Readonly<Record<ToastTone, number>> = {
  info: 4000,
  success: 4000,
  error: 8000,
};

interface ToastState {
  items: ToastItem[];
  show: (message: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  items: [],

  show: (message, tone = 'info') => {
    const id = nextId;
    nextId += 1;
    set((state) => ({ items: [...state.items, { id, message, tone }] }));

    // 定时器不属于 React 生命周期:组件卸载后它仍会跑完,但那时过滤的是一个
    // 已经不含该 id 的列表 —— 没有副作用,也不会内存泄漏(闭包里只有 id)。
    setTimeout(() => {
      set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
    }, TTL_MS[tone]);
  },

  dismiss: (id) => {
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
}));

/**
 * **组件外**弹提示的入口(mutation 回调、store 动作、普通函数)。
 * 组件内也可以用,但那种场景下 `useToastStore` 更直接。
 */
export function toast(message: string, tone: ToastTone = 'info'): void {
  useToastStore.getState().show(message, tone);
}
