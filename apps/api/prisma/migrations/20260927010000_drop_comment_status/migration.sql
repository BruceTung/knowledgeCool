-- 评论就是评论,不是"问题单"。
--
-- 用户明确纠正(2026-09-27):「评论只是评论,不是问题,你不要擅自赋予评论额外的含义」。
-- 这一列连同它带来的整套工作流语义一起去掉:
--   - 界面上不再有「标记已解决 / 重新打开」
--   - 节点树角标改为显示**评论总数**(原来只数 status = 'open' 的)
--   - 接口不再返回 status / openCount
--
-- 依赖该列的 CHECK 约束由 DROP COLUMN 自动一并删除(PostgreSQL 的行为),
-- 所以这里不需要显式 DROP CONSTRAINT。
--
-- 数据无损:被删的只有"结案状态"这一个布尔语义,评论正文与时间戳都在。

ALTER TABLE "comments" DROP COLUMN IF EXISTS "status";
