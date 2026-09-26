/**
 * 「当前有几个模态盖在上面」的全局计数(v2.4)。
 *
 * ## 它解决的唯一问题
 *
 * 全局快捷键(`Ctrl / Cmd + K`)是在 `window` 上监听的,因为用户可能正在正文里
 * 打字 —— 那种时候也要能唤起搜索。但它同样会在**权限弹窗开着**的时候触发,
 * 于是叠出命令面板(两者 z-index 不同,视觉上是"弹窗里又冒出一个搜索框")。
 *
 * 判断"有没有模态"必须是一个**全局**状态:快捷键的监听点在 `AppLayout`,
 * 而模态可能是 `AppLayout` 的兄弟(权限弹窗)也可能是某个路由页面里的。
 * 逐层传 props 会把整棵树弄脏,而这个 store 只有进 / 出两个动作。
 *
 * ## 为什么用计数而不是布尔
 *
 * 理论上确实可能同时开着两层(弹窗里再打开一个确认框)。
 * 布尔量在这种情况下会被后进的那层先关掉 —— 表现是"关掉里面那层,
 * 快捷键却恢复了",而外面那层还开着。
 */
import { useEffect } from 'react';
import { create } from 'zustand';

interface ModalState {
  count: number;
  enter: () => void;
  leave: () => void;
}

const useModalStore = create<ModalState>((set) => ({
  count: 0,
  enter: () => {
    set((state) => ({ count: state.count + 1 }));
  },
  leave: () => {
    // 夹到 0:热更新(HMR)下旧组件的清理可能比新组件的挂载晚一步,
    // 不夹的话计数会漂到负数,于是快捷键**永远**失灵。
    set((state) => ({ count: Math.max(0, state.count - 1) }));
  },
}));

/**
 * 在模态组件里调一次即可:挂载时登记,卸载时注销。
 *
 * ⚠️ 必须调用在**模态真正被挂载**的组件上(而不是父组件),
 * 否则"父组件还活着但模态已关"会让计数一直挂着,快捷键永久失效。
 */
export function useModalOpen(): void {
  useEffect(() => {
    const { enter, leave } = useModalStore.getState();
    enter();
    return () => {
      leave();
    };
  }, []);
}

/** 当前是否有模态开着 —— 给全局快捷键用。 */
export function hasOpenModal(): boolean {
  return useModalStore.getState().count > 0;
}
