/**
 * 个人视图的客户端存储(v2.14)—— 最近浏览 / 收藏 / 检索历史。
 *
 * 用 zustand + localStorage。三条约定:
 *   1. **读取走 `parseStoredList`** —— localStorage 里的东西用户能改,
 *      也可能被别的版本写坏。坏数据必须退化成空列表,不能让首页白屏。
 *   2. **写入要 try/catch** —— 隐私模式下 localStorage 会直接抛异常。
 *      收藏失败不该让页面崩;失败就当作没存上。
 *   3. **时间戳只在动作里取**(`Date.now()` 在渲染期调用会触发 React Compiler 的 purity 检查)。
 */
import { create } from 'zustand';

import {
  isRecentEntry,
  isString,
  parseStoredList,
  pushRecent,
  pushSearchTerm,
  toggleFavorite,
  type RecentEntry,
} from './personal-lists';

const RECENT_KEY = 'kc.recent.v1';
const FAVORITE_KEY = 'kc.favorites.v1';
const HISTORY_KEY = 'kc.search-history.v1';

/** 读 localStorage。任何异常都退化成空列表 —— 隐私模式、配额满、坏数据都算。 */
function read<T>(key: string, guard: (value: unknown) => value is T): T[] {
  try {
    return parseStoredList(window.localStorage.getItem(key), guard);
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不上就算了(隐私模式下必然如此)。**不能让收藏动作把页面弄崩。**
  }
}

interface PersonalState {
  recent: RecentEntry[];
  favorites: string[];
  history: string[];
  /** 记一次浏览。`title` 一起存下来,首页就不必为每条再请求一次详情。 */
  visit: (id: string, title: string) => void;
  toggleFavorite: (id: string) => void;
  rememberSearch: (term: string) => void;
  clearHistory: () => void;
}

export const usePersonal = create<PersonalState>((set, get) => ({
  recent: read(RECENT_KEY, isRecentEntry),
  favorites: read(FAVORITE_KEY, isString),
  history: read(HISTORY_KEY, isString),

  visit: (id, title) => {
    const next = pushRecent(get().recent, { id, title, at: Date.now() });
    write(RECENT_KEY, next);
    set({ recent: next });
  },

  toggleFavorite: (id) => {
    const next = toggleFavorite(get().favorites, id);
    write(FAVORITE_KEY, next);
    set({ favorites: next });
  },

  rememberSearch: (term) => {
    const next = pushSearchTerm(get().history, term);
    write(HISTORY_KEY, next);
    set({ history: next });
  },

  clearHistory: () => {
    write(HISTORY_KEY, []);
    set({ history: [] });
  },
}));
