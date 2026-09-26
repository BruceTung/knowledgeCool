-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "department" TEXT,
    "avatar_color" TEXT NOT NULL DEFAULT 'gray',
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "letter" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'blue',
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_members" (
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_members_pkey" PRIMARY KEY ("space_id","user_id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "space_id" UUID NOT NULL,
    "parent_id" UUID,
    "title" TEXT NOT NULL DEFAULT '未命名页面',
    "position" INTEGER NOT NULL DEFAULT 0,
    "materialized_path" TEXT NOT NULL DEFAULT '',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'published',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_contents" (
    "page_id" UUID NOT NULL,
    "content_json" JSONB NOT NULL DEFAULT '{"type": "doc", "content": []}',
    "ydoc_snapshot" BYTEA,
    "text_for_search" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_contents_pkey" PRIMARY KEY ("page_id")
);

-- CreateTable
CREATE TABLE "page_permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "page_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "deny" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "page_id" UUID NOT NULL,
    "parent_id" UUID,
    "user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_slug_key" ON "spaces"("slug");

-- CreateIndex
CREATE INDEX "pages_tree_idx" ON "pages"("space_id", "parent_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "page_permissions_page_id_subject_type_subject_id_key" ON "page_permissions"("page_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "comments_page_idx" ON "comments"("page_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_created_idx" ON "audit_logs"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "pages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_contents" ADD CONSTRAINT "page_contents_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_permissions" ADD CONSTRAINT "page_permissions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- 以下四类是 Prisma schema 语言**无法表达**、但 DESIGN.md §4.2 要求的部分,
-- 由 `prisma migrate dev --create-only` 生成后手工补齐。
-- 改这些内容必须同时改 DESIGN.md,否则文档失去「唯一施工依据」的地位。
-- =====================================================================

-- 1) CHECK 约束
-- 状态枚举一律用 text + CHECK,刻意不用 PG enum:
-- enum 增删取值要 ALTER TYPE,且历史上无法在事务内执行,迁移会很痛。
ALTER TABLE "users"
    ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'disabled'));

ALTER TABLE "space_members"
    ADD CONSTRAINT "space_members_role_check" CHECK ("role" IN ('admin', 'editor', 'commenter', 'viewer'));

ALTER TABLE "pages"
    ADD CONSTRAINT "pages_status_check" CHECK ("status" IN ('draft', 'published', 'archived'));

ALTER TABLE "page_permissions"
    ADD CONSTRAINT "page_permissions_subject_type_check" CHECK ("subject_type" IN ('user', 'group'));

-- 注意这里**没有 admin** —— 空间管理层级不能通过页面规则授予(DESIGN.md §4.1)
ALTER TABLE "page_permissions"
    ADD CONSTRAINT "page_permissions_role_check" CHECK ("role" IN ('editor', 'commenter', 'viewer', 'none'));

ALTER TABLE "comments"
    ADD CONSTRAINT "comments_status_check" CHECK ("status" IN ('open', 'resolved'));

-- 2) 物化路径的前缀索引
-- 查「某页面的所有祖先」是 '/p1/p2%' 这类前缀匹配,必须带 text_pattern_ops
-- 才能吃到索引(否则 C 排序规则下会退化成全表扫描)。
CREATE INDEX "pages_path_idx" ON "pages" ("materialized_path" text_pattern_ops);

-- 3) 部分索引:只索引未删除的页面
-- 列表与检索都只关心活着的行;回收站是少数派,不该让死行占索引体积。
CREATE INDEX "pages_alive_idx" ON "pages" ("space_id") WHERE "deleted_at" IS NULL;

-- 4) pg_trgm 的 GIN 索引 —— DESIGN.md §2.3 的核心决策
-- 中文没有空格,tsvector 分词器会把整句当成一个 token;三元组索引才能让
-- ILIKE '%关键词%' 走索引。阶段二换 Meilisearch 时此索引可保留或删除。
CREATE INDEX "page_contents_trgm_idx" ON "page_contents" USING gin ("text_for_search" gin_trgm_ops);
