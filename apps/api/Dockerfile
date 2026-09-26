# ============================================================
# 知源 API 镜像 —— 多阶段构建
#
# 构建上下文是**仓库根目录**(monorepo 需要整个 workspace 才能装依赖):
#   docker build -f apps/api/Dockerfile .
#
# 基础镜像用 node:22-alpine,不是 20:
# Prisma 7 要求 ^20.19 || ^22.12 || >=24,Vite/Vitest 要求 ^20.19 || >=22.12,
# 用 node:22-alpine 才能同时满足。详见 DESIGN.md §2.1 的版本约束说明。
# ============================================================

# ---------------- 构建阶段 ----------------
FROM node:22-alpine AS builder

WORKDIR /app

# corepack 会按 package.json 的 packageManager 字段拉取指定版本的 pnpm
RUN corepack enable

# 先只拷清单文件,让依赖安装这一层能被缓存住
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# allowBuilds 白名单写在 pnpm-workspace.yaml 里,所以 prisma/swc 的 postinstall 会正常执行
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

# shared 必须先构建:api 通过 workspace 链接引用它的 dist 产物
RUN pnpm --filter @knowledgecool/shared build \
  && pnpm --filter @knowledgecool/api exec prisma generate \
  && pnpm --filter @knowledgecool/api build

# ---------------- 运行阶段 ----------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable \
  && mkdir -p /data/uploads

# pnpm 的 node_modules 内部是相对符号链接(→ ../../node_modules/.pnpm/...),
# 因此根 node_modules 与各包的 node_modules 必须**保持相同相对位置**一起拷贝。
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/apps/api/prisma7.config.ts ./apps/api/prisma7.config.ts
# api 通过 workspace 链接引用 shared,所以它的产物也要带上
COPY --from=builder /app/packages/shared ./packages/shared

WORKDIR /app/apps/api

EXPOSE 3000

# 先应用迁移再启动。
# migrate deploy 只跑未应用的迁移,幂等;容器重启不会重复执行。
# 注意:不在这里用 migrate dev —— 它需要影子库,生产环境不该有。
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
