# 知源 KnowledgeCool · 设计说明书

| 项 | 值 |
|---|---|
| 文档版本 | v1.4 |
| 最后更新 | 2026-09-26 |
| 状态 | M1 已完成并实测验收通过;M2 进行中 —— 认证后端已端到端实测(初始化 / 登录 / 登出 / 全局守卫 / 会话吊销),空间 CRUD 与前端页面待做 |
| 定位 | 内网自托管 · 企业内部员工知识库 |

---

## 0. 文档说明

### 0.1 本文是什么

本文是阶段一的**唯一施工依据**。包含:技术栈定稿、系统架构、完整数据模型(含建表 DDL)、权限判定逻辑、接口清单、前端架构、关键流程、里程碑任务拆解,以及为阶段二预留的硬约束。

编码时任何与本文冲突的实现,以本文为准;若本文确实有错,先改本文再改代码。

### 0.2 本文不是什么

- 不是阶段二 / 阶段三的设计。协同编辑、行内锚定评论、通知推送、SSO 都只在第 10 节留了约束,没有详细设计。
- 不是部署手册。部署文档在 M6 产出。

### 0.3 已锁定的三个决策

以下三项已确认,后续不再讨论:

1. **全 TypeScript 技术栈** —— 后端 Node + NestJS,前端 React + TS。Java 方案已排除(理由见 §2.2)。
2. **实时多人协同排在阶段二** —— 阶段一只打地基,不接协同。
3. **阶段一包含"页面级评论"** —— 不锚定到具体文字,不含通知推送。

### 0.4 关键区分(务必理解)

> **"阶段一不做协同"指的是不做"多人同时在线的产品能力",不是"不按协同的地基来写代码"。**

这是全文最重要的一句话。混淆这两个概念,会导致阶段二推倒重来。具体来说:阶段一不用 Yjs,但**正文必须存成 ProseMirror 的文档树 JSON,绝不允许存 Markdown 字符串**。

---

## 1. 项目定位与范围

### 1.1 定位

一个部署在公司内网的多人知识库。解决的核心问题:**知识散落在个人电脑、聊天记录和邮件里,找不到、留不住、新人上手慢。**

不做的事:不做对外帮助中心(不需要 SEO、不需要公开站点样式)、不做多租户 SaaS(不需要租户隔离)。

### 1.2 阶段一交付清单

验收标准只有一条:**一个同事在内网里能完整用起来。**

| # | 交付项 | 验收口径 |
|---|---|---|
| 1 | Docker Compose 一键起 | PG · Redis · API · Web 四个容器,一条命令起来 |
| 2 | 账号登录与管理员初始化 | 库为空时引导创建首个管理员 |
| 3 | 空间创建与成员邀请 | 成员可增删,角色可改 |
| 4 | 页面树 CRUD 与拖拽排序 | 含软删除与子页面级联标记 |
| 5 | Tiptap 编辑器 | 标题 / 列表 / 代码块 / 图片 / 表格 / 引用 |
| 6 | 页面级权限 + 服务端强制拦截 | 四层继承、就近覆盖、deny 优先 |
| 7 | 全文检索(中文可用) | 结果按权限过滤后才返回 |
| 8 | 软删除与回收站 | 恢复时子页面一并恢复 |
| 9 | 页面级评论 | 页面底部讨论串 + 已解决状态;**不含**行内锚定与通知推送 |

### 1.3 阶段一明确不做

实时多人协同 · 行内锚定评论 · 通知推送 · SSO / 企业微信登录 · 版本历史与差异对比 · 语义问答 RAG · 模板中心 · 移动端适配 · 开放 API · 自定义用户组。

**把这些写进文档,是为了防止开发中途被不断加需求。** 任何人想加需求,先改这一节。

### 1.4 三阶段路线图

| 阶段 | 目标 | 关键内容 |
|---|---|---|
| 一 | 一个同事能完整用起来 | 身份 · 空间 · 页面树 · 编辑器 · 权限 · 检索 · 回收站 · 页面级评论 |
| 二 | 团队真正协作起来 | Yjs 协同 · 行内锚定评论 · 通知中心 · 版本历史 · Meilisearch 全文检索 |
| 三 | 企业化与规模化 | SSO · 部门树与用户组 · 审计看板 · 导入导出 · 开放 API · 移动端 |

---

## 2. 技术栈定稿

### 2.1 选型表

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | React 18 + TypeScript + Vite + TailwindCSS | 生态最全,Tiptap 一等支持 |
| 编辑器 | Tiptap(ProseMirror) | 协同扩展 `y-prosemirror` 现成,阶段二只需挂上 |
| 后端 | **Node 22 LTS** + **NestJS 12(ESM-only)** + **Prisma 7** | 与前端同语言;Prisma 迁移清晰、类型安全。版本与模块制式的**实测依据见 §2.5** |
| 测试 | **Vitest**(shared / api / web 三处统一)+ 后端配 `unplugin-swc` + `@swc/core` | 见 §2.5 —— 这不是偏好,是依赖注入能否工作的硬要求 |
| 主库 | PostgreSQL 16 | 递归查询、JSONB、模糊检索索引一个库全解决 |
| 缓存 | Redis 7 | 权限判定缓存 + 任务队列(阶段二加在线态) |
| 全文检索 | **阶段一 pg_trgm 子串匹配 → 阶段二 Meilisearch** | 见 §2.3 —— 中文是这里的关键约束 |
| 文件存储 | 本地卷(预留 MinIO 接口) | 内网单机部署,本地目录最省事 |
| 反向代理 | Nginx + certbot | 见 §2.4 |
| 部署 | Docker Compose | 四个容器,单机起步 |
| 包管理 | pnpm workspaces(monorepo) | `packages/shared` 让前后端共享类型 —— 这正是选 TS 的收益 |

### 2.2 为什么排除 Java(结论与证据)

选全 TypeScript 不是偏好,是被协同引擎的生态决定的:

- Yjs 的跨语言实现在 **y-crdt(Rust)** 项目下,官方绑定覆盖 Python(pycrdt)、Ruby、.NET、Swift、**Kotlin(ykt)**、Elixir、R、WASM —— **没有 Java 绑定**。
- 纯 Java 只能走 `yffi`(社区维护的 C FFI)自己写 JNI / JNA 封装,交付要带 native `.so`,内网私有化部署多一层麻烦。
- **一个必须避开的坑**:服务端"只做无状态转发、不持有权威 Y.Doc"是**不够的**。不持有权威文档就无法完成 Yjs 同步协议的 `sync step 1/2` 握手;极端情况下新客户端发完 step 1,唯一的对端刚好断线,它会永远等不到响应。结果就是客户端互相覆盖、重连期间的变更丢失。(参考:yjs 社区讨论;XWiki 论坛中一个纯 Java Wiki 接入 Yjs 的同类案例,结论一致。)

若将来因组织原因必须用 Java,务实方案是**双运行时**:Java 负责业务 REST 与权限,协同网关单独部署一个进程(`y-sweet` 是 Rust 单二进制,可以不引入 Node)。阶段一不采用此方案。

### 2.3 中文检索:一个容易踩的坑

**PostgreSQL 自带的 `tsvector` 分词器对中文基本不可用。** 它按空格与标点切词,而中文句子没有空格 —— `to_tsvector('simple','空间成员按职责划分')` 会把整串当成**一个 token**,搜"空间"命中不了。这不是配置问题,是分词器本身不支持。

三条出路:

| 方案 | 代价 | 中文效果 |
|---|---|---|
| **pg_trgm + ILIKE**(阶段一采用) | 零额外容器。`pg_trgm` 是 postgres contrib 标准模块,官方镜像自带,只需 `create extension` | 三元组索引支持 `LIKE '%关键词%'`,中文子串命中够用 |
| zhparser / pg_jieba 扩展 | 需要在镜像里编译扩展,自建镜像 | 效果最好,但要维护 Dockerfile |
| Meilisearch(阶段二采用) | 多一个容器 | 原生支持中文分词,还有拼写容错和相关度排序 |

**阶段一决定用 pg_trgm**,理由是它不增加运维负担,而阶段一的检索需求就是"按关键词找页面"。**阶段二换 Meilisearch** —— 当文档量上千、用户开始抱怨"搜不准"时,这个容器就值得加了。

> 注意:这与早期原型里写的 "PG tsvector" 不同,是写本文时发现的修正。

### 2.4 内网也必须上 HTTPS

不是安全洁癖,是功能依赖:浏览器的**非安全上下文**会限制剪贴板 API、部分 WebSocket 升级行为、Service Worker。而"粘贴图片直接上传"和阶段二的协同恰好都要用到这些。

内网用自签证书或公司内部 CA 都可以,但不要图省事走 `http://`。

### 2.5 模块制式与测试栈:三个实测结论(2026-09-26 开工时发现)

> 本节 v1.2 新增。v1.1 只写「Node 20 + NestJS」,没锁版本、没定模块制式。开工实测后发现三个直接决定代码怎么写的事实,必须先固化,否则 M3 之后返工。

**结论一:NestJS 12 是 ESM-only。**

`@nestjs/common` / `@nestjs/core` / `@nestjs/config` 的 12.x 全部是 `"type": "module"`,且 `exports` 里**没有 `require` 条件**;CJS 只能靠 Node 22.12+ 的 `require(esm)` 互操作去加载它。

官方对两条路都给了模板(`@nestjs/schematics` 自带 `ts` 与 `ts-esm`),但**新项目默认是 ESM**。官方 SWC 文档原文:

> "New NestJS projects that use ES modules (**the default**) are already set up with Vitest."
> "The SWC builder emits the same module format as the TypeScript compiler would: ES modules when your `package.json` sets `"type": "module"` (the default for new projects), and CommonJS otherwise."

**本项目选 ESM**:官方默认路径,且不必依赖 `--experimental-vm-modules` 与 `require(esm)` 互操作(那是给存量 CJS 项目过渡用的)。

**结论二:esbuild 不产出装饰器元数据 —— 所以 Vitest 必须配 SWC。**

NestJS 的依赖注入靠 `emitDecoratorMetadata` 产出的 `design:paramtypes`。实测 esbuild 0.28.2:

```
tsconfigRaw { experimentalDecorators: true, emitDecoratorMetadata: true }
→ 输出中 has 'design:paramtypes' === false,且零警告(参数被静默忽略)
```

Vite / Vitest 默认用 esbuild 转译 TS,因此**裸用 Vitest 会让「按构造函数类型注入」在测试里直接解析失败**。官方 Vitest 文档明确要求:

> `npm i --save-dev vitest unplugin-swc @swc/core`
> `plugins: [ // **This is required** to build the test files with SWC   swc.vite({ ... }) ]`

故后端测试栈 = Vitest + `unplugin-swc`,并在配置里显式写 `legacyDecorator: true`、`decoratorMetadata: true`,不依赖默认值。

**结论三:Prisma 7 有三处破坏性变化。**

| 变化 | 影响 |
|---|---|
| 生成器改为 `prisma-client`,`output` **必填**,产出 **TypeScript 源码** | 生成物落 `apps/api/src/generated/prisma`,由本项目 tsc 一起编译;**必须同时进 .gitignore 与 eslint ignores** |
| `datasource` 不再写 `url`,连接串移到 **`prisma7.config.ts`** | 该文件须 `import 'dotenv/config'` —— Prisma 7 不再自动加载 .env |
| 连接**必须**经 driver adapter(`@prisma/adapter-pg`) | 内置引擎直连已移除,`PrismaService` 需显式传 adapter |

还有一个 ESM 专属的坑:生成器默认产出 `from "./enums"`(**无扩展名**),经 tsc 编译后在 ESM 下会直接 `ERR_MODULE_NOT_FOUND`。必须显式打开:

```prisma
generator client {
  provider            = "prisma-client"
  moduleFormat        = "esm"
  importFileExtension = "js"
}
```

**连带影响:Node 20 不够用。** 三个依赖的下限是 Prisma 7 `^20.19 || ^22.12 || >=24`、Vite/Vitest `^20.19 || >=22.12`、NestJS 12 `>=20`。取交集并避开 `node:20-alpine` 的具体小版本,**本地与容器统一用 Node 22 LTS**。TypeScript 同理取 **6.0.x**(NestJS 12 官方模板锁 `^6.0.2`)。

---

## 3. 系统架构

### 3.1 阶段一部署形态(4 个容器)

```
                    ┌──────────────────────────┐
   浏览器  ───────► │  web   Nginx + 静态资源   │
                    │        + 反向代理         │
                    └────────────┬─────────────┘
                                 │ /api  (HTTP)
                    ┌────────────▼─────────────┐
                    │  api   NestJS            │
                    │  REST · 鉴权 · 权限判定    │
                    │  页面树 · 评论 · 检索      │
                    └──────┬────────────┬──────┘
                           │            │
                 ┌─────────▼──┐   ┌─────▼────────┐
                 │ postgres   │   │  redis       │
                 │ 主数据     │   │ 权限缓存/队列 │
                 └────────────┘   └──────────────┘
```

阶段一只需这 4 个容器。**阶段二会新增第 5 个:协同网关**(Hocuspocus 或 y-sweet),它与 api 共用同一个 PostgreSQL 和同一套 JWT。

### 3.2 分层职责

| 层 | 职责 | 明确不负责 |
|---|---|---|
| web | 渲染、路由、编辑交互 | 不做任何权限判断(只藏 UI) |
| api | 鉴权、权限判定、业务逻辑、数据读写 | 不直接服务静态资源 |
| postgres | 主数据 + 权限规则 + 检索索引 | 不存文件二进制 |
| redis | 权限判定缓存、异步任务队列 | 不作为唯一数据源 |

**铁律:权限判断只在服务端做。前端藏 UI 是体验,不是安全。**

---

## 4. 数据模型

### 4.1 设计要点

1. **正文与检索分离。** 正文是 ProseMirror 文档树(JSONB),给检索用的纯文本单独一列。JSONB 没法直接做模糊匹配。
2. **权限只存显式规则,不存最终结果。** 运行时沿物化路径向上回溯计算,配 Redis 缓存。否则一次权限变更要递归重写整棵子树。
3. **物化路径(`materialized_path`)。** 把祖先链存成一个字符串(如 `/p1/p2/p3`),查"某页面的所有祖先"从递归 CTE 变成一次前缀索引扫描。
4. **软删除 + 级联标记。** 删除父页面时,整棵子树跟着标记 `deleted_at`;恢复时一并恢复。这是最容易做错的地方。
5. **评论表不含 anchor 字段。** 阶段一是页面级评论,加锚点是阶段二的事 —— 现在不加,免得有人顺手用上。
6. **乐观锁 `version`。** 结构操作(改名、移动、删除)走 REST 并校验 version,冲突返回 409。

### 4.2 建表 DDL

```sql
create extension if not exists citext;    -- 邮箱大小写不敏感
create extension if not exists pg_trgm;   -- 中文子串检索

-- ---------------- 用户 ----------------
create table users (
  id             uuid primary key default gen_random_uuid(),
  email          citext not null unique,
  name           text not null,
  password_hash  text not null,
  department     text,                          -- 阶段一的"用户组"就取这个字段
  avatar_color   text not null default 'gray',
  status         text not null default 'active'
                 check (status in ('active','disabled')),
  is_super_admin boolean not null default false,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------- 空间 ----------------
create table spaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  letter     text not null,                     -- 侧边栏展示用的单字
  color      text not null default 'blue',
  owner_id   uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------- 空间成员(权限判定的兜底层) ----------------
create table space_members (
  space_id   uuid not null references spaces(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null
             check (role in ('admin','editor','commenter','viewer')),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

-- ---------------- 页面树(核心表) ----------------
create table pages (
  id                uuid primary key default gen_random_uuid(),
  space_id          uuid not null references spaces(id) on delete cascade,
  parent_id         uuid references pages(id) on delete restrict,
  title             text not null default '未命名页面',
  position          integer not null default 0,      -- 同级排序
  materialized_path text not null default '',        -- '/<祖先id>/.../<自身id>'
  depth             integer not null default 0,
  status            text not null default 'published'
                    check (status in ('draft','published','archived')),
  version           integer not null default 1,      -- 乐观锁
  created_by        uuid not null references users(id),
  updated_by        uuid references users(id),
  deleted_at        timestamptz,                     -- 软删除
  deleted_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index pages_tree_idx  on pages (space_id, parent_id, position);
create index pages_path_idx  on pages (materialized_path text_pattern_ops);
create index pages_alive_idx on pages (space_id) where deleted_at is null;

-- ---------------- 正文 ----------------
create table page_contents (
  page_id         uuid primary key references pages(id) on delete cascade,
  content_json    jsonb not null default '{"type":"doc","content":[]}'::jsonb,
  ydoc_snapshot   bytea,                    -- 阶段二启用,阶段一保持 null
  text_for_search text not null default '', -- 由 content_json 抽出的纯文本
  updated_at      timestamptz not null default now()
);

create index page_contents_trgm_idx
  on page_contents using gin (text_for_search gin_trgm_ops);

-- ---------------- 页面权限(只存显式规则) ----------------
create table page_permissions (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid not null references pages(id) on delete cascade,
  subject_type text not null check (subject_type in ('user','group')),
  subject_id   text not null,     -- user.id,或部门名(users.department)
  role         text not null
               check (role in ('editor','commenter','viewer','none')),
  deny         boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (page_id, subject_type, subject_id)
);

-- ---------------- 页面级评论(阶段一) ----------------
create table comments (
  id         uuid primary key default gen_random_uuid(),
  page_id    uuid not null references pages(id) on delete cascade,
  parent_id  uuid references comments(id) on delete cascade,  -- 一层回复
  user_id    uuid not null references users(id),
  body       text not null,
  status     text not null default 'open'
             check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
  -- 阶段二会新增 anchor_type / anchor_text / anchor_pos 三列
);

create index comments_page_idx on comments (page_id, created_at);

-- ---------------- 审计日志 ----------------
create table audit_logs (
  id          bigserial primary key,
  actor_id    uuid references users(id),
  action      text not null,          -- page.create / page.move / perm.update ...
  target_type text not null,
  target_id   text not null,
  detail      jsonb not null default '{}'::jsonb,
  -- v1.2 修正:原写 inet,但 Prisma 没有 inet 标量,无法在 schema 里表达。
  -- 阶段一不按 IP 查询/聚合,text 完全够用;将来真要网段查询再引单独的类型化列。
  ip          text,
  created_at  timestamptz not null default now()
);

create index audit_created_idx on audit_logs (created_at desc);
```

### 4.3 字段级说明(几处反直觉的地方)

| 位置 | 说明 |
|---|---|
| `pages.materialized_path` | 移动页面时必须**递归重建整棵子树**的路径。这是最容易漏的一步 —— 只改自己的路径,所有子孙都会失效。 |
| `pages.parent_id` 用 `on delete restrict` | 不允许物理删除有子节点的页面,强制走软删除流程。 |
| `page_contents.ydoc_snapshot` | 阶段一保持 `null`,但**字段先建好**。这就是"按协同的地基写代码"。 |
| `page_permissions.subject_id` 用 text | 阶段一的 subject 可能是 `users.id`(uuid)也可能是部门名(text),统一存 text。阶段二引入 `groups` 表时再规整。 |
| `comments` 无 anchor 列 | 刻意如此,见 §4.1 第 5 条。 |
| 三个"手写"索引 | 原计划三个索引都只能在 migration 里手写。v1.4 实测发现其中**两个可以表达进 schema**:`pages_path_idx` 用 `ops: raw("text_pattern_ops")`,`page_contents_trgm_idx` 用 `type: Gin` + `ops: raw("gin_trgm_ops")`。**这一点很要紧**:凡 schema 里没声明的索引,`prisma migrate dev` 会生成 `DROP INDEX` 把它删掉 —— 若删掉三元组索引,中文检索会静默退化成全表扫描(正是 §12 说的"错了不会立刻报错"那类)。只有 `pages_alive_idx`(部分索引)Prisma 不管理、也不会删,仍需手写。另:`pages_path_idx` 的 ops 与 Prisma 内省结果无法完全对齐,漂移检测会输出一对无害的 drop+create(定义相同),不要误判为故障。 |

---

## 5. 权限模型

### 5.1 四层继承结构

```
组织级   Owner · Admin · Member · Guest
   │  继承
空间级   空间管理员 · 编辑者 · 评论者 · 只读
   │  继承
页面级   默认继承父页面,可显式覆盖
   │  继承
分享链接  阶段一不做(阶段三)
```

### 5.2 判定逻辑

```ts
// packages/shared/src/permission.ts
// 输入:当前用户、目标页面。输出:有效角色。
// 不缓存结果到数据库,只缓存到 Redis。

export async function effectiveRole(
  ctx: { userId: string; isSuperAdmin: boolean },
  pageId: string,
): Promise<Role> {
  // 超管直通,但依然写审计日志
  if (ctx.isSuperAdmin) return 'admin';

  const page = await getPage(pageId);
  if (!page) return 'none';

  // 1) 用物化路径一次查出「根 → 当前」的整条链
  const chain = await getAncestorChain(page.materialized_path); // 从粗到细

  let best: Role | null = null;

  // 2) 从粗到细遍历,后写覆盖先写 —— 这就是「就近覆盖」
  for (const node of chain) {
    const rules = await matchRules(node.id, ctx.userId); // 命中:直接用户 / 用户组 / 部门
    for (const r of rules) {
      if (r.deny) return 'none';   // 「拒绝优先」,直接短路
      best = r.role;
    }
  }

  if (best) return best;

  // 3) 页面链上没有显式规则,兜底到空间角色
  return (await getSpaceRole(ctx.userId, page.spaceId)) ?? 'none';
}
```

### 5.3 四条铁律

| 规则 | 含义 | 为什么 |
|---|---|---|
| **就近覆盖** | 子节点显式规则优先于祖先 | 允许"整空间只读,但这一篇放开编辑" |
| **默认继承** | 没写规则就向上取 | 不写规则 = 继承,而不是"没权限" |
| **拒绝优先** | `deny` 一票否决,不受层级影响 | 允许"整空间可编辑,但这一篇禁止某人访问" |
| **最小可见** | 无权限的页面在列表和检索里**根本不出现** | 不能让人知道"这里有一篇你看不到的文档" |

#### 同层多规则命中时的次序(v1.2 补充)

§5.2 的伪代码只规定了**层与层之间**的次序(由粗到细、后写覆盖),没有规定**同一层内**多条规则同时命中时谁赢。这一点必须在实现前定死 —— 否则同一份数据在不同遍历顺序下会得出不同权限,而这类 bug 不会立刻报错。

约定两条:

1. **deny 先于一切。** 本层命中的规则里只要有一条 `deny=true`,立刻返回 `none`:不再看本层其余规则,不再看更细的层,也不回退空间角色。
2. **user 强于 group。** 都是 allow 时,`subject_type='user'`(直接授给这个人)比 `subject_type='group'`(部门)更具体,取 user 的。

这两条实现在 `packages/shared/src/permission.ts` 的 `resolveRoleAlongChain()`,并在 `packages/shared/test/permission.spec.ts` 中有对应用例 —— 其中包含「把规则顺序颠倒结果不变」的测试,确保结论不依赖规则在数据库里的物理顺序。

#### `deny` 与 `role='none'` 的分工(v1.5 定稿)

`page_permissions` 同时有 `role='none'` 与 `deny` 两个字段,读起来像冗余,其实**语义不同** —— 这一点必须在实现前说清,否则会把两者写反,而写反了不会报错:

| 表达 | 含义 | 能否被更具体的层推翻 |
|---|---|---|
| `deny = true` | **绝对否决**。沿链遍历时立即短路 | ❌ 不能。这就是「铁律:拒绝优先」 |
| `role = 'none'`(且 `deny=false`) | 本层**不给**权限,但更深的层可以再给 | ✅ 能。这就是「铁律:就近覆盖」 |

**两者都必要,不是冗余:**

- 只有 `deny` 的话,「整棵子树关掉、但其中一篇对某人放开」做不到 —— deny 会一路短路。
- 只有 `role='none'` 的话,「这个人绝对不能看」做不到 —— 子页面一条 allow 就能推翻。

**UI 约定(v1.5 定稿):权限弹窗里的「拒绝访问」一律写 `deny = true`,不写 `role='none'`。**

理由是管理员的直觉:点了「拒绝访问」就应该真的拒绝,不该被下层某条规则悄悄推翻。`role='none'`(可被覆盖的那个)仍保留在接口层,留给「整块关掉、个别放开」这类需求,但**阶段一的界面不暴露它**。

对应实现:`resolveRoleAlongChain()`(见本节开头的同层次序约定);测试在 `permission.spec.ts`,含「自身节点的 deny 压过自身节点的 allow」与「页面规则里的 none(非 deny)也能显式降权」两个用例。

### 5.4 权限矩阵

| 动作 | 只读 | 评论者 | 编辑者 | 空间管理员 |
|---|---|---|---|---|
| 查看页面 | ✓ | ✓ | ✓ | ✓ |
| 发表 / 回复评论 | ✗ | ✓ | ✓ | ✓ |
| 标记评论已解决 | ✗ | 自己的 | ✓ | ✓ |
| 创建 / 编辑页面 | ✗ | ✗ | ✓ | ✓ |
| 删除页面(软) | ✗ | ✗ | ✓ | ✓ |
| 从回收站恢复 | ✗ | ✗ | ✓ | ✓ |
| 修改页面权限 | ✗ | ✗ | ✗ | ✓ |
| 邀请 / 移除成员 | ✗ | ✗ | ✗ | ✓ |
| 查看审计日志 | ✗ | ✗ | ✗ | ✓ |

### 5.5 缓存与失效

- 判定结果写入 Redis,key 形如 `perm:{userId}:{pageId}`,**TTL 30 秒**。
- 权限变更时**主动失效**受影响子树的缓存(用 `materialized_path` 前缀批量删),不等 TTL 到期。
- 因此"权限变更最迟 30 秒生效"是**上限**,不是常态。这个数字要写进产品说明,避免用户困惑。

---

## 6. 接口设计

### 6.1 通用约定

- 前缀 `/api/v1`,全部返回 JSON。
- 认证:HttpOnly Cookie 承载**不透明会话 id**,不用 localStorage 存 token。会话的存储位置与理由见 §6.1.1。
- 错误体统一:

```json
{ "error": { "code": "FORBIDDEN", "message": "你没有编辑该页面的权限" } }
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登录或会话过期 |
| `FORBIDDEN` | 403 | 已登录但无权限 |
| `NOT_FOUND` | 404 | 不存在,**或存在但无权访问**(最小可见原则:不区分这两者) |
| `VALIDATION_FAILED` | 400 | 参数校验失败 |
| `VERSION_CONFLICT` | 409 | 乐观锁冲突,客户端需重新拉取 |
| `RATE_LIMITED` | 429 | 触发限流 |

> `NOT_FOUND` 不区分"不存在"与"无权限",是刻意的:否则可以通过错误码枚举出别人的文档 ID。

- 分页:评论与审计日志用游标分页(`?cursor=&limit=`);页面树一次性返回整棵(已按权限过滤)。

### 6.1.1 会话机制(v1.4 定稿)

v1.1~v1.3 只写了「HttpOnly Cookie 承载会话」这个**载体**,没定义会话本身是什么;而 §3.1 又提到阶段二协同网关要与 api「共用同一套 JWT」。两处合起来读会产生歧义,这里定死。

**决定:阶段一用「不透明会话 id + 服务端会话表」,不用 JWT。**

- 登录成功后生成 256 位随机 token,写入 HttpOnly / SameSite=Lax / Path=/ 的 Cookie(名 `kc_session`)。
- **库里只存 token 的 SHA-256,不存 token 本身** —— 即使数据库被读走,也无法据此伪造登录态。
- 会话记录落 **PostgreSQL 的 `sessions` 表**,带 `expires_at`。

三条理由:

1. **可吊销。** 登出、停用账号、把某人移出空间,都必须立刻失效。JWT 要做到同样效果就得再维护一份 denylist —— 那等于把「无状态」省下的成本又原样花回去。
2. **符合 §3.2 的分层原则。** §3.2 明确 Redis「不作为唯一数据源」。若会话只放 Redis,Redis 就成了登录态的唯一来源:一次 flush 全员掉线,而且它从「可降级缓存」变成了「认证硬依赖」。放 PG 则 Redis 保持纯缓存角色。
3. **不引入签名密钥轮换问题。** 不透明 token 的强度来自随机性、不依赖密钥,所以 `SESSION_SECRET` 可以留给阶段二签短期 JWT 用。

**代价:** 每个已认证请求多一次 PG 主键查询。本项目规模下可忽略,且 §5.5 的权限判定本来就要查库或查缓存。

**与 §3.1「同一套 JWT」的关系(阶段二路径,此处只记约束):** 协同网关真正需要的是「握手时验证一次身份、之后不查库」。届时由 api 用 `SESSION_SECRET` **签发一枚短期 JWT** 交给网关即可,而不是把阶段一也改成 JWT —— 这样阶段一的吊销能力不受影响。

**运维注意:`SESSION_COOKIE_SECURE` 默认跟随 `NODE_ENV=production` 打开。** §2.4 已要求内网也上 HTTPS,但 TLS 要到 M6 才落地;在那之前若走 http 访问(例如本机 compose 验收),必须显式设 `SESSION_COOKIE_SECURE=false`,否则浏览器不会回传 Cookie。

### 6.2 接口清单

| 方法 | 路径 | 最低权限 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | — | 登录,下发会话 Cookie |
| POST | `/auth/logout` | 登录 | 登出 |
| GET | `/auth/me` | 登录 | 当前用户 + 可见空间列表 |
| POST | `/auth/setup` | — | **仅当库中无用户时可用**,创建首个管理员 |
| GET | `/auth/setup-state` | — | v1.4 新增:返回 `{ required: boolean }`,供前端 `/setup` 判断该显示引导页还是登录页 |
| GET | `/spaces` | 登录 | 我可见的空间 |
| POST | `/spaces` | 登录 | 新建空间(创建者成为管理员) |
| GET | `/spaces/:id/members` | viewer | 成员列表 |
| POST | `/spaces/:id/members` | admin | 邀请成员 / 创建账号 |
| PATCH | `/spaces/:id/members/:uid` | admin | 修改成员角色 |
| DELETE | `/spaces/:id/members/:uid` | admin | 移除成员 |
| GET | `/spaces/:id/pages` | viewer | 整棵页面树(已过滤) |
| POST | `/pages` | editor | 新建,服务端计算 `materialized_path` |
| GET | `/pages/:id` | viewer | 单页元信息 |
| PATCH | `/pages/:id` | editor | 改标题 / 状态,带 `version` |
| POST | `/pages/:id/move` | editor | 拖拽排序与改父级,**递归重建子树路径** |
| DELETE | `/pages/:id` | editor | 软删除,级联标记子页面 |
| GET | `/pages/:id/content` | viewer | 取正文 |
| PUT | `/pages/:id/content` | editor | 存正文,同步重算 `text_for_search` |
| GET | `/pages/:id/permissions` | viewer | 读显式规则 + 推导链 |
| PUT | `/pages/:id/permissions` | admin | 整表替换,变更后主动失效缓存 |
| GET | `/pages/:id/comments` | viewer | 页面评论列表 |
| POST | `/pages/:id/comments` | commenter | 发表评论或回复(带 `parent_id`) |
| PATCH | `/comments/:id` | 作者 / admin | 标记已解决、重新打开、编辑正文 |
| DELETE | `/comments/:id` | 作者 / admin | 删除评论 |
| GET | `/search?q=` | 登录 | 模糊检索,**结果按权限过滤后返回** |
| GET | `/trash` | 登录 | 回收站列表 |
| POST | `/pages/:id/restore` | editor | 恢复(含子页面) |
| DELETE | `/pages/:id/purge` | admin | 彻底删除 |
| GET | `/audit-logs` | admin | 审计日志 |

**阶段二占位(不实现)**

| 方法 | 路径 | 说明 |
|---|---|---|
| WS | `/collab?pageId=&token=` | 握手时校验页面写权限,无权限直接拒绝连接;只读用户标记 `readOnly`,服务端丢弃其 outgoing update |

---

## 7. 前端架构

### 7.1 仓库结构(monorepo)

```
knowledgeCool/
├─ apps/
│  ├─ web/                 # React + Vite
│  │  └─ src/
│  │     ├─ routes/        # 页面级组件
│  │     ├─ features/      # editor / tree / permissions / comments / search
│  │     ├─ components/    # 通用 UI
│  │     └─ lib/api.ts     # 统一请求封装
│  └─ api/                 # NestJS
│     └─ src/
│        ├─ modules/       # auth / user / space / page / permission / comment / search / audit
│        ├─ common/        # 守卫、拦截器、异常过滤器
│        └─ prisma/        # schema.prisma + migrations
├─ packages/
│  └─ shared/              # 前后端共享:类型、权限常量、错误码
├─ prototype/              # 交互原型(UI 参考,不参与构建)
├─ docs/
│  └─ DESIGN.md            # 本文
├─ docker/
│  └─ nginx.conf
├─ docker-compose.yml
└─ pnpm-workspace.yaml
```

`packages/shared` 是选全 TS 的最大收益点:角色枚举、错误码、DTO 类型只定义一次,前后端同时受益。

### 7.2 路由与页面

| 路由 | 页面 |
|---|---|
| `/login` | 登录 |
| `/setup` | 首次部署的管理员初始化 |
| `/s/:spaceId` | 空间首页 |
| `/s/:spaceId/p/:pageId` | 文档页(主工作面) |
| `/s/:spaceId/members` | 成员与角色 |
| `/s/:spaceId/trash` | 回收站 |
| `/search` | 检索结果 |
| `/audit` | 审计日志(admin) |

主工作面是**唯一的编辑界面**:左侧页面树 / 中间编辑器 / 右侧上下文面板(目录·评论)。全局检索是 `Cmd/Ctrl + K` 命令面板,不占版面。

### 7.3 状态管理

- 服务端状态:TanStack Query(缓存、失效、重试都交给它)。
- 本地 UI 状态:Zustand(侧栏折叠、当前 Tab 之类)。
- **不引入 Redux** —— 这个规模用不上。

### 7.4 编辑器与文档模型

- Tiptap 配置为输出 ProseMirror JSON,`content_json` 列的格式与之**逐字节对应**。
- 阶段二接协同时,`y-prosemirror` 的 `XmlFragment` 与这个 JSON 结构是 1:1 映射的,不需要改存储层。这就是现在把模型定对的价值。
- **禁用编辑器自带的撤销栈之外的问题**:阶段一用自带的即可;阶段二挂 Yjs 时必须关掉它并改用 `Y.UndoManager`,否则会有两套撤销栈打架。这一条写在第 10 节。

---

## 8. 关键流程

### 8.1 页面移动(最容易做错的一个)

```
POST /pages/:id/move  { newParentId, newPosition }
  1. 校验目标父节点不是自身或自身的子孙(防止环)
  2. 校验目标父节点在同一空间内
  3. 校验操作者对目标父节点有 editor 权限
  4. 更新本节点 parent_id / position
  5. ⚠️ 递归重建整棵子树的 materialized_path 与 depth
  6. 删除以旧路径为前缀的权限缓存
  7. 写审计日志
全过程在一个数据库事务里完成。
```

第 5 步是绝对重点。只改自己的路径,所有子孙的路径都会失效,权限判定会跟着出错,而且**不会立刻报错** —— 这是最危险的一类 bug。

### 8.2 软删除与恢复

```
DELETE /pages/:id
  1. 递归收集整棵子树 id(用 materialized_path 前缀查)
  2. 整批设置 deleted_at / deleted_by(同一时间戳)
  3. 审计日志记录子树规模
POST /pages/:id/restore
  1. 若原父节点已被删除,则挂到空间根节点下
  2. 整批清空 deleted_at / deleted_by
```

### 8.3 检索(含权限过滤)

```
GET /search?q=知识
  1. 先算出该用户可见的 page_id 集合(空间成员 + 权限规则)
  2. SELECT ... FROM page_contents
     WHERE text_for_search ILIKE '%' || q || '%'
       AND page_id = ANY(可见集合)
     ORDER BY similarity(text_for_search, q) DESC
     LIMIT 20;
  3. 返回结果里剔除 title 命中但正文无权限的项
```

**必须先在 SQL 里做权限过滤,不能查完再在应用层筛。** 否则记录数、耗时、分页游标都会泄露不可见文档的存在。

### 8.4 页面级评论

```
POST /pages/:id/comments  { body, parentId? }
  1. 校验对该页面至少有 commenter 权限
  2. parentId 若非空,校验其属于同一页面,且不产生二层以上嵌套
  3. 写入,status = 'open'
  4. 更新页面树上的评论角标计数(前端从列表长度算,不额外存字段)
```

阶段一**不发任何通知**。用户怎么知道有新评论?靠页面树上的角标,以及"最近访问"里的未读标记。这是刻意的范围控制 —— 通知是阶段二的事。

---

## 9. 阶段一里程碑任务拆解

以下按**单人全时**估算,共约 **22 个工作日**,预留缓冲后 **4~5 周**。

> 说明:这个数字比早期口头估的"3~4 周"要长。原因是把"页面级评论 + 审计日志 + 备份脚本"正式纳入范围了。宁可报长做短。

### M1 · 基础设施(3 天)

- [x] monorepo 初始化(pnpm workspaces + tsconfig base)
- [x] `docker-compose.yml`:postgres / redis / api / web
- [x] NestJS 骨架 + Prisma 接入 + 首次 migration
- [x] `packages/shared` 建立,放角色枚举、错误码、DTO 类型
- [x] 健康检查接口 + 统一异常过滤器
- **验收**:`docker compose up` 后 `/api/v1/health` 返回 200
  —— **已达成(2026-09-26)**。补充实测口径:先 `docker compose down -v` 清空数据卷,
  再 `docker compose up -d`,6.5 秒全部就绪;经 Nginx 反代访问 `/api/v1/health` 得
  `{"status":"ok",...}`;`/api/v1/health/ready` 同时报告 database 与 redis 均为 up;
  全新建库的迁移自动执行,扩展 `citext`/`pg_trgm`、8 张业务表与三个手写索引(含部分索引与
  GIN 三元组索引)均已就位。

### M2 · 身份与空间(4 天)

- [x] users / spaces / space_members 表与迁移
- [x] 密码哈希 + 会话 Cookie + 鉴权守卫(实现为**不透明会话 token**,不是 JWT —— 见 §6.1.1)
- [x] `/auth/setup` 首次初始化(另新增公开接口 `GET /auth/setup-state`)
- [x] 空间列表、创建空间、成员增删改角色
- [x] 前端引导页、登录页、空间列表、空间概览、成员管理页
- **验收**:全新数据库启动后能创建管理员**并建出第一个空间**
  —— **已达成(2026-09-26)**。实测口径:`docker compose down -v` 清空数据卷 → `up -d --build`
  → 走完整链路 **41 项断言全通过**,且**覆盖失败路径**:未登录 401、重复初始化 403、
  缺参与非法 slug 400、非成员得到 `NOT_FOUND`(而非 `FORBIDDEN`)、commenter 越权 403、
  所有者不可降级 / 不可移除、畸形 spaceId 400、移除非成员 404。
  单测:api 104 项 + shared 59 项 + web 10 项。前端四个页面已用无头浏览器实渲染确认。
- **本阶段额外的两处修补**(不属原计划,但发现即修):
  1. `users.last_login_at` 原为**死字段**(schema 有、全代码库无写入),现于签发会话后写入,写失败不影响登录成功。
  2. 前端 `apiFetch` 的 **header 覆盖 bug**:`...init` 原先展开在 `headers` 之后,调用方一旦传 headers,
     `Accept: application/json` 就被整块顶掉。已调整展开顺序。

### M3 · 页面树(5 天)

- [ ] pages 表、物化路径与 depth 维护逻辑
- [ ] 页面树 CRUD + `move`(含递归重建路径)+ 防环校验
- [ ] 软删除 / 回收站 / 恢复(子树级联)
- [ ] 前端页面树组件:展开折叠、新建、删除、**拖拽排序(三区命中)**
- **验收**:把一棵三层子树拖到另一个分支下,查库确认所有子孙的路径都已更新

### M4 · 正文与检索(6 天)

- [ ] page_contents 表 + ProseMirror JSON 存取
- [ ] `content_json` → `text_for_search` 的纯文本抽取器
- [ ] Tiptap 编辑器:工具栏、图片上传(本地卷)、表格、代码块
- [ ] `pg_trgm` 索引 + `/search` 接口(含权限过滤)
- [ ] 前端编辑器页 + `Cmd/Ctrl + K` 命令面板
- **验收**:中文关键词能搜到正文里的内容,且搜不到无权限页面的内容

### M5 · 权限与评论(5 天)

- [ ] page_permissions 表 + `effectiveRole` 判定实现
- [ ] Redis 缓存 + 变更时按路径前缀批量失效
- [ ] 全接口接上权限守卫,**逐条写测试**(至少覆盖每条铁律一个用例)
- [ ] comments 表 + 4 个接口
- [ ] 前端:权限设置弹窗(继承开关 + 推导链 + 规则增删)、评论面板
- [ ] 审计日志写入与查询页
- **验收**:权限矩阵里每一格都有对应的通过 / 拒绝测试

### M6 · 收尾(3 天)

- [ ] 页面导出为 Markdown / PDF
- [ ] 备份脚本:`pg_dump` + 附件目录打包,**含恢复演练脚本**
- [ ] 部署文档 + `.env.example` + 初始化说明
- [ ] 全量冒烟测试 / 走查
- **验收**:在干净机器上照部署文档从零跑通一遍

---

## 10. 为阶段二预留的六条硬约束

**阶段一可以不做协同,但必须按这些约束写。违反任何一条,阶段二都要返工。**

| # | 约束 | 违反的后果 |
|---|---|---|
| 1 | **房间标识用 `page_id`** —— 一篇文档一个 Y.Doc | 用 slug 或 URL 做房间名,页面改名后协同直接断 |
| 2 | **正文存结构化文档树,绝不存 Markdown 字符串** | 阶段二整个内容层推倒重来 |
| 3 | **WebSocket 握手校验页面写权限**,只读用户标记 `readOnly`,服务端丢弃其 update | 只读成员能绕过前端直接改文档 |
| 4 | **结构操作(改名 / 移动 / 删除)走 REST + 乐观锁,不进 CRDT** | 这类操作在 CRDT 里无法收敛,会出现幽灵页面 |
| 5 | **落库策略:最后一人离开立即存,或静默 2 秒防抖存**;版本快照按每 10 分钟或每 500 次更新打点 | 协同产生的更新量远超单机,没有策略会丢数据或撑爆日志表 |
| 6 | **Yjs 二进制快照不能直接检索**,落库时同步拍纯文本 | 接上协同后检索全废 |

### 10.1 阶段二接协同时必须同步改的地方(备忘)

- 关闭 Tiptap 自带的撤销栈,改用 `Y.UndoManager`,否则两套撤销栈打架。
- `page_contents.ydoc_snapshot` 开始写入,与 `content_json` 并存一段过渡期。
- 权限变更需要通过协同网关广播,让在线用户立刻感知降权,而不是等 Redis TTL。
- 检索从 `pg_trgm` 换到 Meilisearch。

---

## 11. 风险与开放问题

### 11.1 阻塞项

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | **备份介质未落实** | 备份脚本写了也没地方放;知识库丢失比没做更糟 | **最高优先级,开工前必须确定。** 备份必须有一份异地的 |
| 2 | ~~与既有知识库项目的关系未界定~~ | **已关闭(2026-09-26)** | 用户已明确放弃该项目 —— 原「替代 / 并存」之争不复存在。若该项目中已沉淀有需要保留的内容,是否迁移到本项目需单独确认,但**不阻塞开工** |

### 11.2 技术风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 单机部署无冗余 | 本地卷存附件,机器坏了附件就没了 | 备份脚本 + 异地保存;附件目录单独挂盘 |
| 大文档编辑器性能 | 几千行的页面,Tiptap 首次渲染会卡 | M4 压测;必要时引入分块加载,但那是阶段二的事 |
| `pg_trgm` 检索精度 | 对长文档的相关度排序不如专业搜索引擎 | 阶段一可接受;阶段二换 Meilisearch |
| 中文分词 | 已在 §2.3 给出方案,但 `ILIKE '%x%'` 在超大表上仍需注意 | 阶段一数据量下无虞;上量后必须迁 Meilisearch |

### 11.3 待确认(不阻塞开工)

- 附件单文件大小上限、允许的扩展名白名单。
- 回收站保留天数(暂定 30 天)。
- 是否需要"仅创建者可见的草稿"这一状态(数据模型已预留 `draft`,但阶段一是否启用待定)。
- 移动端:阶段一完全不做,但要提前确认"同事会不会真的在手机上查文档",如果是刚需,响应式布局的成本要提前排进去。

---

## 12. 附:开发约定

- **提交规范**:`feat: / fix: / refactor: / docs: / chore:`,一个提交只做一件事。
- **分支**:`main` 保持可运行;功能开 `feat/xxx`,合并前必须过 M 阶段对应的验收。
- **测试优先级**:权限判定 > 页面树移动 > 软删除恢复 > 其他。前三个是"错了不会立刻报错"的类型,必须有测试兜住。
- **密钥管理**:任何密钥、`.env`、凭证不入库、不写入文档、不留存在共享机器上。仓库根目录的 `.gitignore` 已覆盖。
- **提交前自检**:`pnpm typecheck && pnpm lint && pnpm test`。

---

## 附:变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-26 | v1.0 | 初稿。检索方案由早期的 "PG tsvector" 修正为 "pg_trgm + ILIKE"(原因见 §2.3:tsvector 分词器对中文不可用) |
| 2026-09-26 | v1.1 | §11.1 关闭「与既有知识库项目的关系」这一阻塞项 —— 用户已放弃该项目,不再并存。阻塞项由两项减为一项 |
| 2026-09-26 | v1.2 | 开工实测后回写,共三处:①**§2.5 新增** —— NestJS 12 是 ESM-only 且官方新项目默认 ESM,故本项目采用 ESM;实测 esbuild 即使开 `emitDecoratorMetadata` 也不产出 `design:paramtypes`,故 Vitest 必须配 `unplugin-swc`;Prisma 7 的生成器 / 配置文件 / driver adapter 三处破坏性变化,以及 `importFileExtension` 这个 ESM 专属坑。连带把 Node 20 → **22 LTS**、TypeScript → **6.0.x**(均给出依赖下限依据)。②**§4.2** `audit_logs.ip` 由 `inet` 改为 `text`(Prisma 无 inet 标量)。③**§5.3** 补充同层多规则命中次序(user 强于 group;deny 先于一切)—— 原伪代码未定义该情形。 |
| 2026-09-26 | v1.3 | M1 完成并**实测验收通过**(装上 Docker Desktop 后补跑):`docker compose down -v` 清空数据卷 → `up -d` → 6.5 秒四容器就绪;经 Nginx 反代 `/api/v1/health` 返回 200、`/api/v1/health/ready` 报 database 与 redis 均 up;全新建库迁移自动执行,扩展与三个手写索引均就位。同步修正两处实现缺陷:①`pnpm-lock.yaml` 与 package.json 的 typescript 版本不一致(`--frozen-lockfile` 会失败,影响任何全新克隆与 CI);②api 镜像原用 `pnpm exec` 调 prisma,导致每次容器启动都去外网下载 pnpm 并 relink 依赖(启动 39s+ 且耦合外网),改为直调 `./node_modules/.bin/prisma` 后降到 6.5s。§9 的 M1 任务项已勾选完成。 |
| 2026-09-26 | v1.4 | ①**§6.1.1 新增**:定死会话机制 —— 不透明会话 id + PG `sessions` 表(库里只存 token 的 SHA-256),并说明为何不用 JWT(可吊销 / 符合 §3.2「Redis 不作为唯一数据源」/ `SESSION_SECRET` 留给阶段二签短期 JWT);同时给出与 §3.1「同一套 JWT」的衔接路径与 `SESSION_COOKIE_SECURE` 的运维注意。②**§4.3 补充**:实测发现三个"手写索引"中有两个可以表达进 schema(`pages_path_idx` 用 `ops: raw("text_pattern_ops")`、`page_contents_trgm_idx` 用 `type: Gin` + `ops: raw("gin_trgm_ops")`)—— 这一点很要紧,因为 schema 里没声明的索引会被 `migrate dev` 生成 `DROP INDEX` 删掉,而删掉三元组索引会让中文检索**静默**退化成全表扫描。③**§6.2 新增接口** `GET /auth/setup-state`(公开):§7.2 的 `/setup` 路由需要它才能判断该显示引导页还是登录页。④**M2 进度**:认证后端已完成并端到端实测(初始化 / 登录 / 登出 / 守卫 / 会话吊销),另新增 72 字节密码上限校验以规避 bcrypt 静默截断。 |
| 2026-09-26 | v1.5 | ①**§5.3 新增**「`deny` 与 `role='none'` 的分工」小节 —— 两者语义不同且**都必要**(deny 是绝对否决、`role='none'` 可被更具体的层推翻),并定死 UI 约定:「拒绝访问」写 `deny=true`,原型的对应交互同步修改。②**§9 的 M2 全部勾选完成**并补齐实测口径(41 项端到端断言 + 各包单测数)。③**修复死字段**:`users.last_login_at` 此前 schema 有、全代码库无写入,现于登录与初始化时写入。④**去重**:`toSpaceRole` 由 auth / space 两处私有副本上提到 `packages/shared/src/roles.ts`。⑤**修复前端请求封装的 header 覆盖 bug**:`apiFetch` 原先把 `...init` 展开在 `headers` 之后,导致调用方一旦传 headers,`Accept: application/json` 被整块顶掉。⑥修正 `packages/shared/src/index.ts` 的模块制式注释 —— 它是 **ESM**(`"type": "module"`),原注释误写为「编译为 CommonJS」。 |
