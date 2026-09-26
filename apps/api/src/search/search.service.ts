/**
 * 检索服务(DESIGN.md §8.3)。
 *
 * ## 一条不能破的规矩
 *
 * **权限过滤必须在 SQL 里做,不能查完再在应用层筛。**
 * 否则返回条数、耗时、分页位置都会泄露不可见文档的存在 ——
 * 用户能从"命中 3 条但只显示 1 条"推断出另外两篇的存在与大致长度。
 *
 * ## 为什么是 ILIKE + pg_trgm 而不是 tsvector
 *
 * DESIGN §2.3 记录了这个坑:PostgreSQL 自带的 tsvector 分词器
 * **对中文基本不可用** —— 它按空格和标点切词,而中文没有空格,
 * `to_tsvector('simple','空间成员按职责划分')` 会把整串当成**一个 token**,
 * 搜"空间"什么都搜不到。这不是参数没调对,是分词器本身不支持中文。
 *
 * 所以阶段一用 `pg_trgm`(三元组)+ `ILIKE` 做子串匹配,索引是 GIN 三元组索引。
 * 它没有jieba那种真分词能力,但对"搜一个词/一段话"这个真实用法足够,
 * 而且是 PostgreSQL contrib 自带,不多加一个容器。阶段二换 Meilisearch。
 *
 * ## 排序为什么不只用 similarity()
 *
 * trgm 的 `similarity()` 需要至少 3 个字符才有意义 ——
 * 中文搜两个字(「权限」「部署」)时它普遍是 0,排序会退化成不确定的顺序。
 * 所以主排序键是**命中位置**(标题命中 > 正文命中),`similarity()` 只做同档内的次级排序。
 * 这样无论查询是两个字还是十个字,结果顺序都是稳定且符合直觉的。
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
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService, ancestorIdsOf } from '../permission/permission.service.js';

/** `$queryRaw` 的返回行。列名与 SQL 里的别名逐字对应。 */
interface RawHit {
  id: string;
  space_id: string;
  space_name: string;
  space_slug: string;
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

  async search(
    operator: Actor,
    query: string,
    options?: { spaceId?: string },
  ): Promise<SearchResponse> {
    const startedAt = Date.now();

    const q = query.trim();
    if (q === '') return { query: q, hits: [], tookMs: 0 };
    if (q.length > SEARCH_QUERY_MAX_LENGTH) {
      throw AppError.validation(`搜索关键词不能超过 ${SEARCH_QUERY_MAX_LENGTH} 个字符`);
    }

    // ---- 第一步:算出可见范围(空间 + 被规则单独放开的页面) ----
    const spaceIds = await this.visibleSpaceIds(operator, options?.spaceId);
    if (spaceIds.length === 0) {
      return { query: q, hits: [], tookMs: Date.now() - startedAt };
    }

    const unrestrictedSpaces: string[] = [];
    const allowedPages: string[] = [];

    for (const spaceId of spaceIds) {
      const snapshot = await this.permissions.visibility(operator, spaceId);
      if (snapshot.unrestricted) unrestrictedSpaces.push(spaceId);
      else allowedPages.push(...snapshot.allowed);
    }

    // ---- 第二步:构造范围条件 ----
    const scopeParts: Prisma.Sql[] = [];
    if (unrestrictedSpaces.length > 0) {
      scopeParts.push(
        Prisma.sql`p.space_id IN (${Prisma.join(
          unrestrictedSpaces.map((id) => Prisma.sql`${id}::uuid`),
        )})`,
      );
    }
    if (allowedPages.length > 0) {
      scopeParts.push(
        Prisma.sql`p.id IN (${Prisma.join(allowedPages.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    }
    if (scopeParts.length === 0) {
      return { query: q, hits: [], tookMs: Date.now() - startedAt };
    }

    const scope = Prisma.sql`AND (${Prisma.join(scopeParts, ' OR ')})`;
    const pattern = `%${escapeLike(q)}%`;

    // ---- 第三步:一次查询搞定过滤 + 排序 ----
    // 所有参数都显式写 ::text / ::uuid —— M3 的 `substring(x from $n)` 教训:
    // 参数类型交给 PostgreSQL 推断时,它可能选到一条语义完全不同的重载。
    const rows = await this.prisma.$queryRaw<RawHit[]>(Prisma.sql`
      SELECT p.id,
             p.space_id,
             s.name  AS space_name,
             s.slug  AS space_slug,
             p.title,
             p.materialized_path,
             COALESCE(c.text_for_search, '') AS text_for_search,
             p.updated_at,
             (p.title ILIKE ${pattern}::text) AS title_hit
        FROM pages p
        JOIN spaces s ON s.id = p.space_id
        LEFT JOIN page_contents c ON c.page_id = p.id
       WHERE p.deleted_at IS NULL
         AND (p.title ILIKE ${pattern}::text
              OR COALESCE(c.text_for_search, '') ILIKE ${pattern}::text)
         ${scope}
       ORDER BY
         (CASE WHEN p.title ILIKE ${pattern}::text THEN 2 ELSE 0 END)
         + (CASE WHEN COALESCE(c.text_for_search, '') ILIKE ${pattern}::text THEN 1 ELSE 0 END) DESC,
         GREATEST(
           similarity(p.title, ${q}::text),
           similarity(COALESCE(c.text_for_search, ''), ${q}::text)
         ) DESC,
         p.updated_at DESC
       LIMIT ${SEARCH_HIT_LIMIT}::int
    `);

    const hits = await this.attachBreadcrumbs(rows, q);
    return { query: q, hits, tookMs: Date.now() - startedAt };
  }

  /** 我可见的空间 id 列表。超管看全部(救火用途,与 §5.1 的超管口径一致)。 */
  private async visibleSpaceIds(operator: Actor, only?: string): Promise<string[]> {
    if (operator.isSuperAdmin) {
      const all = await this.prisma.space.findMany({
        where: only === undefined ? {} : { id: only },
        select: { id: true },
      });
      return all.map((row) => row.id);
    }

    const rows = await this.prisma.spaceMember.findMany({
      where: { userId: operator.id, ...(only === undefined ? {} : { spaceId: only }) },
      select: { spaceId: true },
    });
    return rows.map((row) => row.spaceId);
  }

  /**
   * 给命中的页面补上面包屑。
   *
   * 面包屑**不是递归查出来的**,是从物化路径切出祖先 id 再一次性取标题 ——
   * 一条 SQL 解决全部命中项,不做 N+1。
   */
  private async attachBreadcrumbs(rows: readonly RawHit[], q: string): Promise<SearchHit[]> {
    if (rows.length === 0) return [];

    const ancestorIds = new Set<string>();
    for (const row of rows) {
      for (const id of ancestorIdsOf(row.materialized_path)) ancestorIds.add(id);
    }

    const ancestors =
      ancestorIds.size === 0
        ? []
        : await this.prisma.page.findMany({
            where: { id: { in: [...ancestorIds] } },
            select: { id: true, title: true },
          });
    const titleOf = new Map(ancestors.map((row) => [row.id, row.title]));

    return rows.map((row) => {
      const text = row.text_for_search ?? '';
      return {
        pageId: row.id,
        spaceId: row.space_id,
        spaceName: row.space_name,
        spaceSlug: row.space_slug,
        title: row.title,
        snippet: snippetOf(text, q),
        breadcrumb: ancestorIdsOf(row.materialized_path)
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
