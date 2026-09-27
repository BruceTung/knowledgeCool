-- 彻底移除回收站(v2.12)。
--
-- 背景:用户明确要求「不该有回收站这个概念,删除就应该直接删除」。
-- 于是软删除(deleted_at / deleted_by)、保留策略、TrashPage 一并去掉。
--
-- ⚠️⚠️ 这个迁移是**不可逆**的,而且顺序不能颠倒:
--   必须先把库里所有已软删除的节点**物理删掉**,再删列。
--   若只删列,那些 deleted_at is not null 的行会瞬间"复活" ——
--   它们会带着旧的 materialized_path 出现在树、检索与权限判定里,
--   而它们在树上的父节点可能早就不存在了。那是一种**静默的数据损坏**,
--   比迁移失败糟糕得多。
--
-- 删数据为什么要绕这么大一圈:
--   nodes.parent_id 是 ON DELETE RESTRICT(见 init 迁移),
--   而 DELETE 不支持 ORDER BY —— 直接一条语句删整棵子树会撞外键
--   (处理到父行时子行还在)。所以先把"注定要删的"一次算清放进临时表,
--   再按 depth 从深到浅逐层删。
--
--   "一次算清"是必须的:边删边判断的话,父行删掉之后
--   "它的父节点已被软删"这个条件就再也匹配不上了,后代会漏删。

CREATE TEMP TABLE kc_doomed_nodes ON COMMIT DROP AS
WITH RECURSIVE doomed AS (
  -- 起点:所有被软删除的节点
  SELECT id, depth FROM nodes WHERE deleted_at IS NOT NULL
  UNION
  -- 以及它们的全部后代(正常流程下后代也都被标记了,这里仍然补齐,
  -- 免得历史脏数据留下"父已删、子还在"的孤儿)
  SELECT child.id, child.depth
    FROM nodes child
    JOIN doomed parent ON child.parent_id = parent.id
)
SELECT id, depth FROM doomed;

DO $$
DECLARE
  target_depth INT;
  guard INT := 0;
BEGIN
  LOOP
    guard := guard + 1;
    IF guard > 500 THEN
      RAISE EXCEPTION '回收站清理超过 500 层,疑似数据成环,已中止迁移';
    END IF;

    SELECT max(depth) INTO target_depth FROM kc_doomed_nodes;
    EXIT WHEN target_depth IS NULL;

    DELETE FROM nodes WHERE id IN (SELECT id FROM kc_doomed_nodes WHERE depth = target_depth);
    DELETE FROM kc_doomed_nodes WHERE depth = target_depth;
  END LOOP;
END $$;

-- 软删除相关的结构:部分索引、外键、两列
DROP INDEX IF EXISTS "nodes_alive_idx";
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "nodes_deleted_by_fkey";
ALTER TABLE "nodes" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "nodes" DROP COLUMN IF EXISTS "deleted_by";
