/**
 * 检索相关的共享类型 —— 对应 DESIGN.md §6.2 的 `GET /search?q=` 与 §8.3 的实现要点。
 *
 * 一条硬约束(§8.3):**权限过滤必须在 SQL 里做,不能查完再在应用层筛**。
 * 否则返回条数、耗时、分页游标都会泄露不可见文档的存在 ——
 * 用户能从"命中 3 条但只显示 1 条"推断出另外两篇的存在。
 */

/** 一条命中结果。 */
export interface SearchHit {
  pageId: string;
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
  title: string;
  /** 命中位置周围的正文片段,已含 `<em>` 高亮标记(服务端安全转义后拼接)。 */
  snippet: string;
  /** 从根到自身的祖先标题链,用于结果项的路径提示。 */
  breadcrumb: string[];
  /** 命中来源:标题命中还是正文命中。前端用来决定角标。 */
  matchedIn: 'title' | 'content';
  updatedAt: string;
}

/** `GET /search?q=` 的响应体。 */
export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  /** 服务端实际耗时(毫秒)。排查"为什么这么慢"时有用。 */
  tookMs: number;
}

/** 检索关键词长度上限。太长会让 trgm 索引失效并变成全表扫描。 */
export const SEARCH_QUERY_MAX_LENGTH = 100;

/** 单次返回的命中数上限。 */
export const SEARCH_HIT_LIMIT = 20;
