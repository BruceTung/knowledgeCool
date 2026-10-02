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
 * 查询里仍然没有 `ANY(可见集合)` 子查询 —— 那是刻意的:在 SQL 里把安全逻辑
 * 实现第二遍,那份迟早与 permission.ts 分叉(分叉的表现是**静默越权**)。
 *
 * ⚠️ **v4.9 起改为"分批取、取够为止"**(见 `SearchService.search`)。
 * 原来的写法是 SQL 先 `LIMIT 20`、再逐条过滤 —— 于是"命中 25 条而只有 5 条可读"
 * 时用户只看到 0~4 条,而且**完全静默**。现在会按批 over-fetch 直到凑够上限,
 * 凑不够时用 `truncated` 如实告诉调用方"还有没返回的"。
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
  /**
   * 结果**被截断**了(还有更多符合条件的命中没返回)。
   *
   * ⚠️ v4.9 新增。加它的原因是一类**静默的少结果**:
   * 过滤是在 SQL `LIMIT` **之后**逐条做 `canRead` 的,所以当命中很多、
   * 而其中大部分又读不到时,用户只会看到 0~4 条,**却无从知道"还有更多"** ——
   * 界面看起来和"真的只有这几条"一模一样。
   *
   * 假值(`false`)表示"这一页就是全部符合条件的可读结果"。
   */
  truncated: boolean;
}

/** 检索关键词长度上限。太长会让 trgm 索引失效并变成全表扫描。 */
export const SEARCH_QUERY_MAX_LENGTH = 100;

/** 单次返回的命中数上限。 */
export const SEARCH_HIT_LIMIT = 20;
