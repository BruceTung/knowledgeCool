/**
 * 检索相关的共享类型 —— 对应 DESIGN.md §6.2 的 `GET /search?q=` 与 §8.3。
 *
 * ⚠️ **v2.12 起检索要做可见性过滤**,v2.0~v2.11 那一段"读对所有人开放、系统不提供保密"的说法**已经不成立**。
 *
 * 现在的规则是:
 *   · 默认 public 的节点,所有登录用户都能搜到(与树一致);
 *   · `visibility = restricted` 的节点及其整棵子树,**读不到的人搜不到** ——
 *     过滤在 `SearchService.search` 里**逐条**做 `access().canRead`,
 *     而不在 SQL 里重写一遍祖先链判定(那份迟早与 permission.ts 分叉)。
 *
 * 这条过滤**必须在**。检索是最容易漏的一条读取路径:树、详情、导出、评论
 * 都挡住了却漏掉检索的话,受限文档的**标题与正文片段会直接出现在
 * 全公司的搜索结果里**,而保密功能看起来完全正常(§5.6)。
 *
 * 查询里仍然没有 `ANY(可见集合)` 子查询 —— 那是刻意的:命中已 LIMIT 到 20 条,
 * 逐条判定最多 20 次,比在 SQL 里把安全逻辑实现第二遍便宜也更安全。
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
