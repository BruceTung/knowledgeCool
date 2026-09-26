/**
 * 成员弹窗的开关状态(v2.4)。
 *
 * 与权限弹窗(`features/grants/dialog-store`)同一个模式、同一个理由:
 * 入口有**两个** —— 左侧组织树上的成员按钮、文档页顶部的「成员」按钮 ——
 * 它们没有共同的父组件(除了整个 App)。
 *
 * ⚠️ 刻意与权限弹窗分开两个 store 与两个弹窗,而不是合成一个带 Tab 的弹窗:
 * 「成员」是**组织归属**(他在哪个部门/组),「权限」是**判定结果**(他能改什么)。
 * 混在一个界面里会让管理员以为"移出成员 = 收回权限"—— 而那是两件事
 * (移出归属不改变所有权,他该能改的还是能改)。
 */
import { create } from 'zustand';

export interface MembersDialogTarget {
  nodeId: string;
  title: string;
}

interface MembersDialogState {
  target: MembersDialogTarget | null;
  open: (nodeId: string, title: string) => void;
  close: () => void;
}

export const useMembersDialog = create<MembersDialogState>((set) => ({
  target: null,
  open: (nodeId, title) => {
    set({ target: { nodeId, title } });
  },
  close: () => {
    set({ target: null });
  },
}));
