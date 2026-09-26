-- 会话表 —— 阶段一认证(见 DESIGN.md §6.1.1)
--
-- 设计要点:
--   * 主键是 token 的 SHA-256(64 位十六进制),**不存 token 本身**;
--     库被读走也无法据此伪造登录态。
--   * 会话落 PG 而不是 Redis,是为了让 Redis 保持「纯缓存」角色(§3.2:
--     Redis 不作为唯一数据源);否则一次 flush 就全员掉线。
--   * expires_at 上的索引既服务于「过滤过期会话」,也服务于定期清理。

-- CreateTable
CREATE TABLE "sessions" (
    "id" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_idx" ON "sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;