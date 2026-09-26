# ============================================================
# 知源 Web 镜像 —— 多阶段构建:Node 构建静态资源 → Nginx 提供服务
#
# 构建上下文是仓库根目录:
#   docker build -f apps/web/Dockerfile .
#
# 这个容器同时承担 DESIGN.md §3.1 里的两个角色:
# 静态资源服务 + 反向代理(配置见 docker/nginx.conf)。
# ============================================================

# ---------------- 构建阶段 ----------------
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/web apps/web

# 前端引用 @knowledgecool/shared 的类型与常量,先构建它
RUN pnpm --filter @knowledgecool/shared build \
  && pnpm --filter @knowledgecool/web build

# ---------------- 运行阶段 ----------------
FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
