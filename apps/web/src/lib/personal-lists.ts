/**
 * 最近浏览与收藏(v2.14)。
 *
 * ## 为什么放在 localStorage 而不是数据库
 *
 * 这是**个人视图**,不是共享事实:我最近看过哪几篇、我收藏了什么,
 * 对别人没有任何意义。放进库里要新增表、新增接口、新增一轮权限判定,
 * 而这个功能的价值完全不值这些 —— 客户端存就够了。
 *
 * 代价说清楚:换一台电脑就没了,清浏览器数据也会没了。对"最近看过什么"
 * 来说这是可接受的;收藏如果将来要跨设备,那时再挪到库里。
 *
 * ## 为什么把纯逻辑单独导出来
 *
 * 「去重、置顶、截断」这几件事**错了不会报错**:列表里出现两条同名、
 * 或者第 21 条悄悄挤掉了第 1 条。它们是纯函数,能直接用 node 环境的
 * vitest 覆盖(这个仓库的前端测试不引 jsdom),所以单独导出来测。
 */

/** 一条浏览记录。`at` 是时间戳,用来排序;`title` 存下来是为了在首页直接显示, */
/** 不必为每一条再去请求一次节点详情(那会变成 N 次往返)。 */
export interface RecentEntry {
  id: string;
  title: string;
  /** 毫秒时间戳。**只在事件回调里取**(不能在渲染期调 Date.now —— React Compiler 会报 purity) */
  at: number;
}

/** 最多记多少条。20 条足够覆盖"我刚看过的那几篇",再多就成了第二棵树。 */
export const RECENT_MAX = 20;

/**
 * 把一条记录推进列表:已存在则**置顶并更新时间**,不存在则插入队首,超出上限则截断。
 *
 * ⚠️ 去重按 **id** 而不是标题 —— 两篇文档可以重名(不同部门下的"周报"),
 * 按标题去重会把另一篇悄悄吃掉,而表现只是"我明明看过那篇,列表里却没有"。
 */
export function pushRecent(
  list: readonly RecentEntry[],
  entry: RecentEntry,
  max: number = RECENT_MAX,
): RecentEntry[] {
  const rest = list.filter((item) => item.id !== entry.id);
  return [entry, ...rest].slice(0, max);
}

/** 收藏的开关。纯函数,返回新数组。 */
export function toggleFavorite(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [id, ...list];
}

/** 检索历史:最近在前、去重、上限 10 条。 */
export const SEARCH_HISTORY_MAX = 10;

export function pushSearchTerm(
  list: readonly string[],
  term: string,
  max: number = SEARCH_HISTORY_MAX,
): string[] {
  const trimmed = term.trim();
  // 空词不进历史:回车一次空搜索就多一条垃圾记录,而且删不掉
  if (trimmed === "") return [...list];
  return [trimmed, ...list.filter((item) => item !== trimmed)].slice(0, max);
}

/** 从 JSON 里安全读出列表 —— 坏数据一律当空列表,绝不让它把页面弄崩。 */
export function parseStoredList<T>(raw: string | null, guard: (value: unknown) => value is T): T[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(guard);
  } catch {
    return [];
  }
}

export function isRecentEntry(value: unknown): value is RecentEntry {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { id?: unknown; title?: unknown; at?: unknown };
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.at === "number"
  );
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}
