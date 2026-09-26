/**
 * 「待首次改密」的客户端状态(v2.4)。
 *
 * 登录返回 `kind: 'password-change-required'` 时,把那张一次性凭证放这里,
 * 然后跳到改密页。改密页凭它证明身份 —— 因为它**没有会话**可用。
 *
 * ## ⚠️ 刻意只放内存(不落 sessionStorage / localStorage)
 *
 * 两个理由:
 *   1. 它是一张 10 分钟的一次性凭证,没有理由留在磁盘上等 XSS 来拿;
 *   2. 刷新丢失的代价很小 —— 用初始密码再登一次就行。
 *      拿"凭证落盘"去换"刷新不用重登",不划算。
 *
 * 丢掉之后的表现:改密页会把你送回登录页(它既没有凭证、也没有会话)。
 * 这是**正确**的降级,不是故障。
 */
import { create } from 'zustand';

export interface PendingSetup {
  /** 让改密页显示"你在为哪个工号改密" */
  employeeNo: string;
  name: string;
  setupToken: string;
  /** ISO 时间串。仅用于界面提示,真正的过期判定在服务端。 */
  expiresAt: string;
}

interface SetupState {
  pending: PendingSetup | null;
  start: (pending: PendingSetup) => void;
  clear: () => void;
}

export const useSetupStore = create<SetupState>((set) => ({
  pending: null,
  start: (pending) => {
    set({ pending });
  },
  clear: () => {
    set({ pending: null });
  },
}));
