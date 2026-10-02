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
# ⚠️⚠️ v4.38:**先清空目标目录,再拷贝。**
#
# 原来是直接 `COPY --from=builder /app/apps/web/dist /usr/share/nginx/html`。
# 而 Docker 的 `COPY` 到**已存在的目录**是**合并**,不是替换 —— 实测过:
#
#   基础镜像里先放 /html/assets/old-hash.txt 与 /html/index.html,
#   再 COPY 一个只有 assets/a.txt 的目录过去,结果是
#   /html/assets/a.txt + /html/assets/old-hash.txt + /html/index.html
#   —— **旧文件原样留存**。
#
# 这不是理论问题。nginx:alpine 自带的 `index.html` 与 `50x.html` 就是这样留在
# 生产容器里的(实测:`50x.html` 至今还是基础镜像 2025-04 那份)。
# 更要紧的是 **hash 会变的产物**:Vite 每次构建输出 `index-<hash>.js`,
# 换个 hash 就是**新文件名**,于是旧的那份**永远不会被覆盖**,一直堆在镜像里。
# 症状是「镜像越滚越大」,以及老用户在缓存了旧 `index.html` 时会**继续跑到旧代码**。
# (本轮之前那个「出厂镜像里 `*.map` 是旧的」也是同一个机制 —— 当时只改了
#  `vite.config` 的 `sourcemap: false`,但历史产物不会因为新构建而消失。)
#
# 所以这里显式先 `rm -rf` 目标目录。基础镜像自带的 index.html / 50x.html
# 一并清掉 —— 它们对本项目没有用途(路由由 SPA 自己的 index.html 接管)。
RUN rm -rf /usr/share/nginx/html
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
