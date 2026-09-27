/**
 * 可见范围弹窗的开关状态。
 *
 * 与授权弹窗同一个模式(两个入口、没有共同父组件),但**分成两个 store**:
 * 它们是两件事,合并之后会出现"点权限却打开了可见范围"这种由状态串台
 * 造成的怪现象,而这种 bug 只在特定点击顺序下复现。
 */
import { create } from 'zustand';

export interface VisibilityDialogTarget {
  nodeId: string;
  title: string;
}

interface VisibilityDialogState {
  target: VisibilityDialogTarget | null;
  open: (nodeId: string, title: string) => void;
  close: () => void;
}

export const useVisibilityDialog = create<VisibilityDialogState>((set) => ({
  target: null,
  open: (nodeId, title) => {
    set({ target: { nodeId, title } });
  },
  close: () => {
    set({ target: null });
  },
}));
