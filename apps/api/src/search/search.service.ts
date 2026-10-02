/**
 * 检索服务(DESIGN.md §8.3)。
 *
 * ## ⚠️ 可见性过滤(v2.12 起)
 *
 * v2.0~v2.11 这一节写的是「不再做权限过滤,系统不提供保密能力」——
 * 那句话**已经不成立**:v2.12 加了 `visibility = restricted`。
 *
 * 现在的分层是刻意的:
 *   · **SQL 里没有任何"可见集合"子查询** —— 命中已被 LIMIT 到 20 条,
 *     在这 20 条上逐条调 `access().canRead` 比在 SQL 里把「祖先链 + 读者名单」
 *     的判定实现第二遍便宜得多,而且**不会与 permission.ts 分叉**
 *     (分叉的表现是静默越权,不是报错)。过滤在下面 search() 的尾部。
 *   · **检索是最容易漏的一条读取路径。** 树、详情、导出、评论都挡住了、
 *     却漏掉这里的话,受限文档的标题与正文片段会直接出现在全公司的
 *     搜索结果里,而保密功能**看起来完全正常**。这正是它必须写在这里的原因。
 *
 * ## 为什么是 ILIKE + pg_trgm 而不是 tsvector
 *
 * DESIGN §2.3 记录了这个坑:PostgreSQL 自带的 tsvector 分词器
 * **对中文基本不可用** —— 它按空格和标点切词,而中文没有空格,
 * `to_tsvector('simple','空间成员按职责划分')` 会把整串当成**一个 token**,
 * 搜"空间"什么都搜不到。这不是参数没调对,是分词器本身不支持中文。
 *
 * 所以阶段一用 `pg_trgm`(三元组)+ `ILIKE` 做子串匹配,索引是 GIN 三元组索引。
 * 阶段二换 Meilisearch。
 *
 * ## 排序为什么不只用 similarity()
 *
 * trgm 的 `similarity()` 需要至少 3 个字符才有意义 ——
 * 中文搜两个字(「权限」「部署」)时它普遍是 0,排序会退化成不确定的顺序。
 * 所以主排序键是**命中位置**(标题命中 > 正文命中),`similarity()` 只做同档内的次级排序,
 * 最后以 `updated_at` 兜底。这样无论查询是两个字还是十个字,顺序都稳定且符合直觉。
 */

import { Injectable } from '@nestjs/common';
import {
  SEARCH_HIT_LIMIT,
  SEARCH_QUERY_MAX_LENGTH,
  type Actor,
  type SearchHit,
  type SearchResponse,
} from '@knowledgecool/shared';

import { AppError } from '../common/errors/app-error.js';
import { idsOfPath } from '../common/node-path.js';
import { Prisma } from '../generated/prisma/client.js';
import { PermissionService } from '../permission/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** `$queryRaw` 的返回行。列名与 SQL 里的别名逐字对应。 */
interface RawHit {
  id: string;
  title: string;
  materialized_path: string;
  text_for_search: string | null;
  updated_at: Date;
  title_hit: boolean;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  async search(operator: Actor, query: string): Promise<SearchResponse> {
    const startedAt = Date.now();

    /*
      ⚠️⚠️ v4.39:**NUL 必须在「唯一入口」就剔掉,不能只放在 `escapeLike` 里。**

      实测:`GET /search?q=a%00b` → **500 INTERNAL_ERROR**。
      根因在 PostgreSQL:它的 text 类型**不能承载 NUL** ——

        SELECT $1::text  with  a<NUL>b   ->  22021: invalid byte sequence for encoding "UTF8": 0x00
        SELECT $1::text  with  a<0x01>b  ->  OK

      我第一版只改了 `escapeLike`,**没修好** —— 因为下面的 SQL 里
      `similarity(n.title, ${q}::text)` 用的是**未经过 escapeLike 的 q**,
      也就是说同一个值在查询里有两个出口,堵一个不够。

      所以在这里一次性处理:后面的 pattern 与 similarity 都从它派生,
      **不再有第二个出口**。这也说明「补一个转义函数」这种改法容易漏 ——
      真正的规矩是「脏输入只在入口洗一次」。
    */
    const q = query.trim().split('\0').join('');
    if (q === '') return { query: q, hits: [], tookMs: 0, truncated: false };
    if (q.length > SEARCH_QUERY_MAX_LENGTH) {
      throw AppError.validation(`搜索关键词不能超过 ${String(SEARCH_QUERY_MAX_LENGTH)} 个字符`);
    }

    const pattern = `%${escapeLike(q)}%`;

    /*
      ⚠️⚠️ v4.9:**分批取,直到凑够 `SEARCH_HIT_LIMIT` 条可读结果。**

      原来的写法是 SQL 一次 `LIMIT 20`,**之后再**逐条判 `canRead` 并丢掉不可读的
      —— 于是"命中 25 条、其中只有 5 条可读"时,用户只看到 0~4 条,而且**完全静默**:
      界面和"真的只有这几条"长得一模一样。命中越是被受限内容占满,漏得越狠。

      现在的做法:按 `BATCH` 一批批取(每批都带 `OFFSET`),每批过滤后累积,
      够 `SEARCH_HIT_LIMIT` 就停。这样
        · 命中**全部可读**时,行为与从前完全一致(一批就够,只多判一次长度);
        · 命中**大量不可读**时,会继续往后取,而不是把用户看到的结果吃掉;
        · 全库扫完仍不够时,用 `truncated` 如实说明,不再假装"这就是全部"。

      `OFFSET` 配 `ORDER BY` 是稳定的:排序键里有 `n.updated_at` 兜底,而它可能相同 ——
      所以额外加 `n.id` 作为**最终决胜键**,否则翻页时同一条可能重复出现、
      也可能被整个跳过(那正是"分批取"最容易引入的新 bug)。
    */
    const BATCH = SEARCH_HIT_LIMIT * 3;
    const readable: SearchHit[] = [];
    let truncated = false;
    let offset = 0;

    for (;;) {
      // 所有参数都显式写 ::text / ::int —— `substring(x from $n)` 那一次的教训:
      // 参数类型交给 PostgreSQL 推断时,它可能选到一条语义完全不同的重载。
      const rows = await this.prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT n.id,
               n.title,
               n.materialized_path,
               COALESCE(c.text_for_search, '') AS text_for_search,
               n.updated_at,
               (n.title ILIKE ${pattern}::text) AS title_hit
          FROM nodes n
          LEFT JOIN node_contents c ON c.node_id = n.id
          /*
            ⚠️ WHERE 里**不包 COALESCE**(2026-09-28)。

            原来写 COALESCE(c.text_for_search, '') ILIKE ? —— 而表达式索引
            「node_contents_trgm_idx」 建在**裸列** text_for_search 上,
            套了函数之后规划器就认不出、用不上索引。真库 EXPLAIN 实测:
            带 COALESCE 与去掉 COALESCE 的谓词**都是 Seq Scan** ——
            因为 OR 的另一支 n.title ILIKE 在 nodes.title 上根本没有索引
            (见 migration 20260928120000_audit_nodes_indexes)。

            **语义没有变**:「node_contents.text_for_search」 是 NOT NULL 列,
            它只在 LEFT JOIN 没配到行时才是 NULL,而
              · 标题命中时   true  OR NULL = true  -> 入选(与原来一致)
              · 标题不命中时 false OR NULL = NULL  -> 不入选(与原来一致)
            NULL 在 WHERE 里等价于「不满足」,所以四种组合的入选结果完全相同。

            COALESCE 只保留在 SELECT 与 ORDER BY —— 那两处**不参与索引匹配**,
            去掉反而会让排序值变成 NULL,那才是真的改变行为。
          */
         WHERE (n.title ILIKE ${pattern}::text
                OR c.text_for_search ILIKE ${pattern}::text)
         ORDER BY
           (CASE WHEN n.title ILIKE ${pattern}::text THEN 2 ELSE 0 END)
           + (CASE WHEN COALESCE(c.text_for_search, '') ILIKE ${pattern}::text THEN 1 ELSE 0 END) DESC,
           GREATEST(
             similarity(n.title, ${q}::text),
             similarity(COALESCE(c.text_for_search, ''), ${q}::text)
           ) DESC,
           n.updated_at DESC,
           n.id ASC
         LIMIT ${BATCH}::int OFFSET ${offset}::int
      `);

      if (rows.length === 0) break;

      const batchHits = await this.attachBreadcrumbs(rows, q);

      /*
        ⚠️ v2.12:保密过滤。**检索是最容易漏的一条读取路径** ——
        树、详情、导出、评论都挡住了,却忘了检索的话,受限文档的标题与正文片段
        会直接出现在全公司的搜索结果里,而保密功能看起来完全正常。

        逐条判定而不是在 SQL 里过滤:在 SQL 里重写一遍祖先链+名单的判定,
        等于把安全逻辑实现第二遍,那份迟早与 permission.ts 分叉。
      */
      /*
        ⚠️⚠️ v4.47 / v4.48:两步优化,都是实测出来的。

        **先**把 `access()` 换成 `canReadFast()`(拿掉 `chainOf` 的 2 次 DB 查询,
        那部分约 386ms / 55%)—— 因为 `access()` 是**先 chainOf 再查缓存**,
        缓存永远省不掉那两次查询。

        **再**把「逐条取节点」换成**一次批量取**(v4.48):`canReadFast()` 每个命中
        仍要 `pluck()` 一次,实测 600 次单点 = **219ms**,而一次批量取 600 行 = **2ms**。

        ⚠️ 批量返回的 Map **只含缓存命中的**;缺失**不等于不可读** ——
        把「缺失」当「false」会**把该看见的内容藏起来**。所以下面分两步走:
        先查批量结果,命中的直接用;没命中的才逐个回源(`canReadFast` 会顺带写缓存)。
      */
      const batchIds = batchHits.map((hit) => hit.nodeId);
      const cachedReadable = await this.permissions.canReadBatch(operator, batchIds);

      for (const hit of batchHits) {
        const known = cachedReadable.get(hit.nodeId);
        const canRead =
          known !== undefined ? known : await this.permissions.canReadFast(operator, hit.nodeId);
        if (canRead) readable.push(hit);
        if (readable.length >= SEARCH_HIT_LIMIT) break;
      }

      /*
        两种情况都要判断"后面到底还有没有":

        · **凑够了**(readable 已到上限)—— 还要说清"被截断了没有"。
          这一批取满 `BATCH` 条,说明 SQL 侧**至少还有下一批**,
          于是 `truncated = true`;没取满就是真的到底了。
          (注意这里判的是 `rows.length`,**不是** `readable`:
          被过滤掉的那些也占着 SQL 的配额,所以"取满"只看前者。)
        · **没凑够** —— 这一批没取满 `BATCH` 就说明 SQL 侧到底了,收工;
          取满了就继续往后翻。
      */
      if (readable.length >= SEARCH_HIT_LIMIT) {
        if (rows.length === BATCH) truncated = true;
        break;
      }
      if (rows.length < BATCH) break;

      offset += BATCH;
    }

    return {
      query: q,
      hits: readable.slice(0, SEARCH_HIT_LIMIT),
      tookMs: Date.now() - startedAt,
      truncated,
    };
  }

  /**
   * 给命中的节点补上面包屑。
   *
   * 面包屑**不是递归查出来的**,是从物化路径切出祖先 id 再一次性取标题 ——
   * 一条 SQL 解决全部命中项,不做 N+1。
   */
  private async attachBreadcrumbs(rows: readonly RawHit[], q: string): Promise<SearchHit[]> {
    if (rows.length === 0) return [];

    const ancestorIds = new Set<string>();
    for (const row of rows) {
      for (const id of idsOfPath(row.materialized_path)) ancestorIds.add(id);
    }

    const ancestors = await this.prisma.node.findMany({
      where: { id: { in: [...ancestorIds] } },
      select: { id: true, title: true },
    });
    const titleOf = new Map(ancestors.map((row) => [row.id, row.title]));

    return rows.map((row) => {
      const text = row.text_for_search ?? '';
      return {
        nodeId: row.id,
        title: row.title,
        snippet: snippetOf(text, q),
        breadcrumb: idsOfPath(row.materialized_path)
          .map((id) => titleOf.get(id))
          .filter((title): title is string => title !== undefined),
        matchedIn: row.title_hit ? 'title' : 'content',
        updatedAt: row.updated_at.toISOString(),
      };
    });
  }
}

/** 关键词前后的片段长度。 */
const SNIPPET_RADIUS = 50;

/**
 * 生成片段。
 *
 * 只返回**纯文本**,不带任何 HTML —— 高亮交给前端按索引切分。
 * 服务端拼 `<em>` 等于把 HTML 生成放在后端,漏一次转义就是 XSS。
 */
export function snippetOf(text: string, query: string): string {
  if (text === '') return '';
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2);

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * 转义 LIKE 的通配符 —— 用户搜 `100%` 时不该命中所有内容。
 *
 * ⚠️⚠️ v4.39:**同时剔除 NUL 字节(`\u0000`)** —— 那是另一个 500 的来源。
 *
 * 实测:把 `a%00b` 作为 `q` 传给 `GET /search`,整个请求 **500 INTERNAL_ERROR**,
 * 服务端日志里是 `PrismaClientKnownRequestError`。根因在 PostgreSQL 一侧 ——
 * 直接试过:
 *
 *   SELECT $1::text  with  "a\u0000b"  ->  22021: invalid byte sequence for encoding "UTF8": 0x00
 *   SELECT $1::text  with  "a\u0001b"  ->  OK
 *
 * **PG 的 text 类型根本不能承载 NUL**(不是参数化没做好,是编码层的硬限制),
 * 所以这不是「补一个转义」能解决的,只能**在进 SQL 之前把 NUL 去掉**。
 *
 * 为什么不是把 `[\u0000-\u001f]` 全删掉:`\u0001` 这类是**合法**的(PG 收得下),
 * 而它们可能是用户真的想搜的字符。只处理确实会让查询失败的那一个,
 * 不做无谓的改写 —— 这跟「只在必要时才动用户输入」是同一条原则。
 *
 * 去掉之后 `a\u0000b` 变成 `ab`,搜索正常返回(通常是 0 条),不再 500。
 *
 * ⚠️ 用 `split/join` 而不是正则的 `\u0000`:ESLint 的 `no-control-regex`
 * 会（合理地）对正则里的控制字符报警 —— 而且这里本来也不需要正则,
 * 去掉一个固定字符而已。用 `'\0'` 字面量最直白。
 */
export function escapeLike(value: string): string {
  return value
    .split('\0')
    .join('')
    .replace(/[\\%_]/g, (char) => `\\${char}`);
}
