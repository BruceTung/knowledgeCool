/**
 * 检索相关的共享类型 —— 对应 DESIGN.md §6.2 的 `GET /search?q=` 与 §8.3。
 *
 * ⚠️ **v2.0 起检索不再做权限过滤** —— 读本来就是对所有登录用户开放的
 * (§5.3 规则一),树上和检索里都是全集。这带来两个直接好处:
 *   1. 查询里没有 `ANY(可见集合)` 子查询,单次开销明显下降;
 *   2. 不存在"树上看不到、但搜得到"这类泄露 —— 树上本来就没有隐藏项。
 *
 * 代价是**系统不提供保密能力**,这是有意的产品选择(§8.3 有完整说明)。
 */

/** 一条命中结果。 */
export interface SearchHit {
  nodeId: string;
  title: string;
  /**
   * 命中位置周围的正文片段。
   *
   * **纯文本,不带任何 HTML** —— 高亮由前端按索引切分。
   * 服务端拼 `<em>` 等于把 HTML 生成放到后端,漏一次转义就是 XSS。
   * (此处旧注释曾错写成"已含 `<em>` 标记",实现一直是纯文本,已更正。)
   */
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
