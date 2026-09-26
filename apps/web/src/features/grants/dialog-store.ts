/**
 * 权限弹窗的开关状态。
 *
 * 为什么用一个小 store 而不是把 state 放在某一层组件里:这个弹窗有**两个
 * 不同的入口** —— 左侧组织树上的齿轮按钮、以及文档页顶部的「权限」按钮。
 * 前者在 `AppLayout` 里,后者在路由页面里,两者没有共同的父组件
 * (除了整个 App)。层层传回调会把 `AppLayout` 的 props 弄脏,
 * 而这个 store 只有两个动作,是最小代价。
 */
import { create } from 'zustand';

export interface GrantDialogTarget {
  nodeId: string;
  title: string;
}

interface GrantDialogState {
  target: GrantDialogTarget | null;
  open: (nodeId: string, title: string) => void;
  close: () => void;
}

export const useGrantDialog = create<GrantDialogState>((set) => ({
  target: null,
  open: (nodeId, title) => {
    set({ target: { nodeId, title } });
  },
  close: () => {
    set({ target: null });
  },
}));
