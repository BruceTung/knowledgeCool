-- 受限节点 / 保密能力(v2.12)。
--
-- 用户明确要求「保密手段可以加上」。此前读对**所有登录用户**开放,
-- 系统不提供任何保密手段(§5.3 规则一)。
--
-- 两条设计:
--   1. visibility 默认 public —— 存量数据行为完全不变,是**加法**而不是改语义。
--   2. 单独的 node_readers 表,不复用 node_grants:那张表管「能改」,这张管「能读」。
--      合并会让两条路径共用同一次误操作的机会,而误加一次就是一次泄露。

ALTER TABLE "nodes" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';

-- 用 text + check 而不是 PG enum:enum 增删值很痛(与 kind / status 同一套理由)。
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_visibility_check"
  CHECK ("visibility" IN ('public', 'restricted'));

CREATE TABLE "node_readers" (
  "node_id"    UUID NOT NULL,
  "user_id"    UUID NOT NULL,
  "granted_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "node_readers_pkey" PRIMARY KEY ("node_id", "user_id")
);

-- 反查「我被加进了哪些受限节点」要走它
CREATE INDEX "node_readers_user_idx" ON "node_readers"("user_id");

ALTER TABLE "node_readers" ADD CONSTRAINT "node_readers_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_readers" ADD CONSTRAINT "node_readers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- granted_by 用 RESTRICT:删用户时不该静默抹掉「谁授的权」这条痕迹。
ALTER TABLE "node_readers" ADD CONSTRAINT "node_readers_granted_by_fkey"
  FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
