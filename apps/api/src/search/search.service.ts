/**
 * 检索服务(DESIGN.md §8.3)。
 *
 * ## ⚠️ v2.0:不再做权限过滤
 *
 * 读是对所有登录用户开放的(§5.3 规则一),所以树上、检索里都是全集。
 * 这**不是**漏掉了过滤,而是模型变了 —— 因此下面这段 SQL 里
 * 没有任何"可见集合"子查询,这是有意的。
 *
 * 代价必须写进产品说明:**全公司任何人搜任何关键词,都能搜到任何部门的文档。**
 * 将来若冒出保密需求,那要重新设计权限模型,而不是在检索里临时打补丁。
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

    const q = query.trim();
    if (q === '') return { query: q, hits: [], tookMs: 0 };
    if (q.length > SEARCH_QUERY_MAX_LENGTH) {
      throw AppError.validation(`搜索关键词不能超过 ${String(SEARCH_QUERY_MAX_LENGTH)} 个字符`);
    }

    const pattern = `%${escapeLike(q)}%`;

    // 所有参数都显式写 ::text / ::int —— M3 的 `substring(x from $n)` 教训:
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
       WHERE (n.title ILIKE ${pattern}::text
              OR COALESCE(c.text_for_search, '') ILIKE ${pattern}::text)
       ORDER BY
         (CASE WHEN n.title ILIKE ${pattern}::text THEN 2 ELSE 0 END)
         + (CASE WHEN COALESCE(c.text_for_search, '') ILIKE ${pattern}::text THEN 1 ELSE 0 END) DESC,
         GREATEST(
           similarity(n.title, ${q}::text),
           similarity(COALESCE(c.text_for_search, ''), ${q}::text)
         ) DESC,
         n.updated_at DESC
       LIMIT ${SEARCH_HIT_LIMIT}::int
    `);

    const hits = await this.attachBreadcrumbs(rows, q);

    // ⚠️ v2.12:保密过滤。**检索是最容易漏的一条读取路径** ——
    // 树、详情、导出、评论都挡住了,却忘了检索的话,受限文档的标题与正文片段
    // 会直接出现在全公司的搜索结果里,而保密功能看起来完全正常。
    //
    // 逐条判定而不是在 SQL 里过滤:命中已经 LIMIT 到 20 条,这里最多 20 次判定;
    // 而在 SQL 里重写一遍祖先链+名单的判定,等于把安全逻辑实现第二遍,
    // 那份迟早与 permission.ts 分叉。
    const readable: typeof hits = [];
    for (const hit of hits) {
      const access = await this.permissions.access(operator, hit.nodeId);
      if (access.canRead) readable.push(hit);
    }

    return { query: q, hits: readable, tookMs: Date.now() - startedAt };
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

/** 转义 LIKE 的通配符 —— 用户搜 `100%` 时不该命中所有内容。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
