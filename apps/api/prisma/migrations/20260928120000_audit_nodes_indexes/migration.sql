-- 审计与检索的索引补齐(2026-09-28)
--
-- 背景:两处"门禁绿、行为差"的性能问题 —— 查询写得对,但**用不上索引**。

-- ============================================================
-- 一、审计查询(audit.service.ts 的 queryRows)
-- ============================================================
--
-- 那个 WHERE 的形状是:
--     (超管 OR a.actor_id = ? OR a.target_id = ANY(?) OR a.detail->>'nodeId' = ANY(?))
--     AND (action 可选) AND (cursor 可选)
--     ORDER BY a.id DESC LIMIT n
--
-- 而 audit_logs 上**只有** audit_created_idx(created_at DESC) ——
-- 三个条件字段一个索引都没有,排序字段(id)也只有主键。
-- 非超管的查询因此是全表扫 + 排序。
--
-- 为什么三条都要:OR 里只要**有一支**走不了索引,整个 OR 就退化成顺序扫描
-- (规划器无法只对部分分支做 BitmapOr)。所以漏掉任何一条,另两条也白加。

-- CreateIndex
CREATE INDEX "audit_actor_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_target_idx" ON "audit_logs"("target_id");

-- 下面是**表达式索引**,Prisma schema 语法表达不了它。
-- 有意只写在迁移里(不写进 schema.prisma):
-- 将来 prisma migrate dev 会把它当成"库里有、schema 里没有"的未知索引,
-- 并生成一条 DROP INDEX。**届时不要采纳那条 DROP** ——
-- 没有它,上面 OR 里的 JSON 分支就永远走不了索引。
-- (若哪天把 audit.service.ts 改成不依赖 detail 内部字段,才可以删。)
CREATE INDEX "audit_detail_node_idx" ON "audit_logs" ((("detail" ->> 'nodeId')));

-- ============================================================
-- 二、检索的 trgm 索引(search.service.ts)
-- ============================================================
--
-- 谓词原样是:
--     WHERE (n.title ILIKE ? OR COALESCE(c.text_for_search, '') ILIKE ?)
--
-- 已有的 node_contents_trgm_idx 建在 text_for_search 上,但**两条都让它失效**:
--   1. 包了 COALESCE(...) —— 表达式不匹配索引,规划器用不了;
--   2. OR 的另一支 n.title ILIKE 在 nodes.title 上**根本没有索引**。
--
-- 真库 EXPLAIN 实测(见 REMAINING.md 第 6.5 节):
--   · 带 COALESCE                 -> Seq Scan
--   · 去掉 COALESCE、只写裸列     -> **仍然是 Seq Scan**(证明"改 SQL"单独不够)
--   · 根因                        -> nodes.title 上 trgm 索引数 = 0
--
-- 所以两件事要一起做:
--   (a) 本迁移:给 nodes.title 补 GIN 三元组索引;
--   (b) search.service.ts:WHERE 里去掉 COALESCE(只保留在 SELECT / ORDER BY)。

-- CreateIndex
CREATE INDEX "nodes_title_trgm_idx" ON "nodes" USING GIN ("title" gin_trgm_ops);
