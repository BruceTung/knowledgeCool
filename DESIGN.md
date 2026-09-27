# 知源 KnowledgeCool · 设计说明书

| 项 | 值 |
|---|---|
| 文档版本 | v2.11 |
| 最后更新 | 2026-09-27 |
| 状态 | **全部落地并通过全量验收;文档与代码的一致性由机器检查(§0.5)。** §9.2 四个批次(数据模型 / 权限服务 / 组织架构管理 / 前端导航)全部完成;v2.4 补齐「节点成员管理入口」;v2.5 重做首登链路与评论语义;v2.6 补上**管理员重置密码**并让验收脚本自还原;v2.7 让验收脚本的收尾覆盖「密码 + 残留节点 + 被改的所有者」;v2.8 按 **Atlassian Design System 与 Ant Design 的公开规范**重做字号与排版刻度(§7.5);v2.9 补上**点击目标尺寸**下限;v2.10 补齐编辑器的三处能力缺口(§7.4:链接气泡 / 表格行列增删 / 代码块语言高亮);v2.11 做了一次**文档与代码的对账**并把它固化成 `pnpm audit:docs`(§0.5)—— 修掉 §9.1 的自相矛盾、§10 的 v1.x 表名、`.env.example` 里两个从没被读过的开关,并把 `/health` 两条补进接口清单。端到端 **160 项断言全通过**(`pnpm verify:org`,项数恒定);单测 **240 项**(shared 13 / web 52 / api 175);前端用无头浏览器 + CDP 实渲染、驱动交互、并读回**计算字号、点击区尺寸、以及落库后的 JSON 结构**确认。v2.0 起各轮"只有真跑才会暴露"的问题记在 §9.3 / §9.5 / §9.6 / §9.7 / §9.8 / §9.9 |
| 定位 | 内网自托管 · **按公司组织架构组织**的企业知识库 |

---

## 0. 文档说明

### 0.1 本文是什么

本文是阶段一的**唯一施工依据**。包含:技术栈定稿、系统架构、完整数据模型(含建表 DDL)、权限判定逻辑、接口清单、前端架构、关键流程、里程碑任务拆解,以及为阶段二预留的硬约束。

编码时任何与本文冲突的实现,以本文为准;若本文确实有错,先改本文再改代码。

### 0.2 本文不是什么

- 不是阶段二 / 阶段三的设计。协同编辑、行内锚定评论、通知推送、SSO 都只在第 10 节留了约束,没有详细设计。
- 不是部署手册。部署文档在 M6 产出。

### 0.3 已锁定的四个决策

以下四项已确认,后续不再讨论:

1. **全 TypeScript 技术栈** —— 后端 Node + NestJS,前端 React + TS。Java 方案已排除(理由见 §2.2)。
2. **实时多人协同排在阶段二** —— 阶段一只打地基,不接协同。
3. **阶段一包含"页面级评论"** —— 不锚定到具体文字,不含通知推送。
4. **内容按公司组织架构组织(v2.0 锁定)** —— 空间是**组织层级**而非自由容器;人员与归属**预置**;
   权限靠"所有者 + 祖先链 + 显式授权"三个概念;**读全员开放**。决策过程与影响面见 §1.5。

### 0.4 关键区分(务必理解)

> **"阶段一不做协同"指的是不做"多人同时在线的产品能力",不是"不按协同的地基来写代码"。**

这是全文最重要的一句话。混淆这两个概念,会导致阶段二推倒重来。具体来说:阶段一不用 Yjs,但**正文必须存成 ProseMirror 的文档树 JSON,绝不允许存 Markdown 字符串**。

### 0.5 本文与代码的一致性由**机器**检查(v2.11)

这份文档是施工依据,但它**手写的** —— 手写的清单一定会漂:接口加了没写进来、
表改名了文档没跟着改、环境变量写了但代码根本不读。这类漂移**不报任何错**,
只会在某天有人照着文档去做一件事、却发现文档是错的。

所以有 `pnpm audit:docs`(`scripts/audit-docs.mjs`),它检查四件事:

| 检查 | 比对的两侧 | 能抓到的漂移 |
|---|---|---|
| **接口** | §6.2 的表格 ↔ 控制器里 `@Get/@Post/...` 实际注册的路由 | 接口加了没写、文档写了但代码没有 |
| **环境变量** | `process.env.X` ↔ `.env.example` 的键 | 代码读了没声明;**声明了但没人读**(填了不生效的假开关) |
| **文件路径** | 文档里提到的仓库路径 ↔ 文件系统 | 删掉的文件还挂在文档里 |
| **版本号** | 文档头的 `文档版本` ↔ 变更记录最新一行 | 改了内容忘了推进版本 |

两个刻意的设计:

- **双向比对,不是单向**。"文档少写了"和"文档多写了"都要报 ——
  只查一侧的话,另一侧会慢慢烂掉。
- **例外必须写理由。** 有意为之的(历史存档、部署侧文件、由别的程序读的变量)
  进脚本里的例外名单,**每一条都带一句话理由**。没有理由的名单迟早会变成
  "把报错塞进去就完事"的地方,那时这个检查就死了。

> 它已经接过 `pnpm check`(和 typecheck / lint / test 一起跑)。
> 真抓到过东西:§9.1 一边写"`pnpm verify:m4m5` 已删除"、一边写"脚本在仓库里可以自己复现";
> §10 的"硬约束"里还留着 v1.x 的表名 `page_id` / `page_contents`;
> `.env.example` 里有两个从没被读过的开关(`POSTGRES_PORT` / `VITE_API_BASE`);
> `/health` 与 `/health/ready` 两个接口根本没进接口清单。

---

## 1. 项目定位与范围

### 1.1 定位

一个部署在公司内网的多人知识库,**按公司真实的组织架构组织内容**。解决的核心问题:**知识散落在个人电脑、聊天记录和邮件里,找不到、留不住、新人上手慢。**

与"通用知识库"的区别是本项目最重要的一条定位,写在这里以免再走偏:

| | 通用知识库 | 本项目 |
|---|---|---|
| 空间从哪来 | 用户自由创建,可无限多 | **公司既有的部门与组/项目**,预置 |
| 人从哪来 | 注册 / 被邀请进空间 | **全员预置**,且自带组织归属 |
| 权限靠什么 | 空间内的角色等级 | **节点所有者 + 祖先链 + 显式授权** |
| 读的开放度 | 常需逐空间授权 | **全员开放**,系统不提供保密能力 |
| 登录后落点 | 空间列表页 | **直接进工作台**,左侧即完整组织树 |

不做的事:不做对外帮助中心(不需要 SEO、不需要公开站点样式)、不做多租户 SaaS(不需要租户隔离)。

### 1.2 阶段一交付清单

验收标准只有一条:**一个同事在内网里能完整用起来。**

| # | 交付项 | 验收口径 |
|---|---|---|
| 1 | Docker Compose 一键起 | PG · Redis · API · Web 四个容器,一条命令起来 |
| 2 | 账号登录与管理员初始化 | 库为空时引导创建首个管理员;管理员可导入组织架构与人员 |
| 3 | **组织架构(部门 / 组 / 项目)与人员归属** | 部门与二级节点可建、可指定所有者;人员归属可维护,**支持多归属** |
| 4 | 节点树 CRUD 与拖拽排序 | 空间与页面是**同一种节点**;含软删除与子节点级联标记 |
| 5 | Tiptap 编辑器 | 标题 / 列表 / 代码块 / 图片 / 表格 / 引用 |
| 6 | **权限判定 + 服务端强制拦截** | 所有者 + 祖先链 + 显式授权;读全员开放;**授权受组织范围约束** |
| 7 | 全文检索(中文可用) | 全员可搜全库内容(**不做权限过滤** —— 读本来就是全员开放的) |
| 8 | 软删除与回收站 | 恢复时子节点一并恢复 |
| 9 | 页面级评论 | 页面底部讨论串 + 已解决状态;**不含**行内锚定与通知推送。**全员可发** |

### 1.3 阶段一明确不做

实时多人协同 · 行内锚定评论 · 通知推送 · SSO / 企业微信登录 · 版本历史与差异对比 · 语义问答 RAG · 模板中心 · 移动端适配 · 开放 API。

**把这些写进文档,是为了防止开发中途被不断加需求。** 任何人想加需求,先改这一节。

> 注:v1.x 的清单里还有「自定义用户组」。v2.0 起**不再列为不做项** —— 组织架构本身就是分组的载体,
> 「用户组」这个概念已经被 `org_assignments`(组织归属)取代,不需要单独做一套。

### 1.4 三阶段路线图

| 阶段 | 目标 | 关键内容 |
|---|---|---|
| 一 | 一个同事能完整用起来 | 身份 · **组织架构** · 节点树 · 编辑器 · 权限 · 检索 · 回收站 · 页面级评论 |
| 二 | 团队真正协作起来 | Yjs 协同 · 行内锚定评论 · 通知中心 · 版本历史 · Meilisearch 全文检索 |
| 三 | 企业化与规模化 | SSO · 审计看板 · 导入导出 · 开放 API · 移动端 |

### 1.5 为什么改成"组织架构驱动"(v2.0 · 2026-09-26)

初版把空间设计成**用户自由创建的容器**(带成员与五档角色)。这个方向被否掉了 —— 它不是本项目要的东西:

1. **空间不是"容器",是"层级"。** "技术部 → 后端组 → CRM 项目"这种结构**先于知识库存在**,不该由用户在知识库里重新建一遍。用户原话:"我说的空间指的是层级,没有专属空间的说法,只不过空间所属人员权限更高而已。"
2. **人不是"被邀请进空间",而是"本来就在组织里"。** 邀请制意味着大量重复操作,而且会产生"同一个人被邀请进八个空间"这种在真实公司里不成立的状态。
3. **角色等级制与实际管理链条不符。** 真实规则是"**谁建的东西,他的上级链都能改**",不是"某人在这个空间里是什么级别"。
4. **读需要全员开放。** 旧设计的「最小可见」与公司内部知识共享的目标冲突。

**结论:空间与页面合并为一棵节点树,权限退回到三个概念 —— 所有者、祖先链、显式授权。**

**这次变更的影响范围(诚实记录):**

| 影响 | 内容 |
|---|---|
| **作废** | `spaces` / `space_members` / `page_permissions` 三张表;五档角色枚举;能力矩阵查表;`deny` 语义;「最小可见」铁律 |
| **改名** | `pages` → `nodes`,`page_contents` → `node_contents`(结构未变) |
| **新增** | `org_assignments`(组织归属,多对多)、`node_grants`(授权名单)、组织架构维护功能 |
| **不受影响** | 正文(ProseMirror / Tiptap)、中文检索、评论、审计日志、物化路径机制、软删除与恢复、乐观锁 |

原 M2 的「空间与成员」与 M5 的「权限与评论」中权限部分**需要重做**,其余里程碑成果保留。新增任务清单见 §9。

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

> **v2.0 重大变更(2026-09-26)。** 本章整体重写。原设计把「空间」当成用户自由创建的容器(带成员与角色),现改为:**空间是公司既有组织在库里的投影**,且与页面合并为同一棵树。原 `spaces` / `space_members` / `page_permissions` 三张表作废。原因与决策过程见 §1.5。

### 4.1 设计要点

1. **组织架构就是数据结构本身。** 部门是一级节点,组/项目挂在部门下。**人先于内容存在** —— 全员及其组织归属都是预置的,不是注册来的,也不需要"邀请进空间"这个动作。
2. **空间与页面合并成一棵节点树。** 二者没有本质区别:都是"树上一个带标题、可挂子节点、可带正文的东西"。区别只在展示(`kind`)。合并的直接收益:**二级节点下面再套子空间、子页面天然成立**,不必写两套父子逻辑,也不必为"空间套空间"单独设计。
3. **权限不存"角色",只存三种关系。** 没有 owner/admin/editor/viewer 这套等级。判定只问三件事:你是不是这个节点的所有者、你在不在它的祖先链上拥有所有权、你在不在它的显式授权名单里。
4. **读是全员开放的。** 因此**不再有「最小可见」这条铁律**,也不再有 `deny` —— 权限模型里根本没有"拒绝读"这个表达。代价是**系统不具备任何保密能力**,这是有意的产品选择(见 §5.3)。
5. **正文与检索分离。** 正文是 ProseMirror 文档树(JSONB),给检索用的纯文本单独一列。JSONB 没法直接做模糊匹配。
6. **物化路径(`materialized_path`)。** 把祖先链存成一个字符串(如 `/p1/p2/p3`),查"某节点的所有祖先"从递归 CTE 变成一次前缀索引扫描。**权限判定完全依赖它** —— 判定要拿整条祖先链上的所有者,这是整棵树里唯一的性能敏感路径。
7. **软删除 + 级联标记。** 删除父节点时,整棵子树跟着标记 `deleted_at`;恢复时一并恢复。
8. **评论表不含 anchor 字段。** 阶段一是页面级评论,加锚点是阶段二的事 —— 现在不加,免得有人顺手用上。
9. **乐观锁 `version`。** 结构操作(改名、移动、删除、改所有者)走 REST 并校验 version,冲突返回 409。

### 4.2 建表 DDL

```sql
create extension if not exists pg_trgm;   -- 中文子串检索
-- v2.2 起**不再需要 citext** —— 登录标识由邮箱改为「工号」(纯 ASCII 数字/字母,不存在大小写歧义)

-- ---------------- 用户 ----------------
create table users (
  id             uuid primary key default gen_random_uuid(),
  -- 工号(v2.2)。**登录标识就是它**,不是邮箱 —— 用户明确要求「不要用邮箱,用工号」。
  -- 用 text 而非数字:工号常带前缀字母或前导零(如 KC2026001),当成数字会丢信息。
  employee_no    text not null unique,
  name           text not null,
  password_hash  text not null,
  -- 首次登录必须改密(v2.2)。新账号统一初始密码 123456(内置常量,**不进 Excel 模板**),
  -- 所以必须有这个强制开关,否则等于全员同密码上线。
  -- 判定与拦截方式见 §6.1.2 —— 注意**必须服务端拦**,只做前端跳转是无效的。
  must_change_password boolean not null default true,
  avatar_color   text not null default 'gray',
  -- active=在职 · disabled=账号被停用(临时) · departed=**已离职**(v2.1 新增)
  -- 「离职」单独一档而不复用 disabled:两者含义不同,而且前端要在作者名旁显示「已离职」
  status         text not null default 'active'
                 check (status in ('active','disabled','departed')),
  -- 只用于初始化与组织架构维护(建部门 / 导人员 / 任命所有者)。
  -- 它**不参与**日常内容权限判定 —— 新模型里没有"超管能改一切"的旁路,
  -- 超管要看某篇文档,也走和其他人一样的 canRead/canEdit(见 §5.2)。
  is_super_admin boolean not null default false,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- ⚠️ 原 users.department 列已删除:单值部门无法表达"一个人同属多个组/项目"。
--    组织归属改由 org_assignments 表承载。

-- ---------------- 节点树(空间与页面合并,核心表) ----------------
create table nodes (
  id                uuid primary key default gen_random_uuid(),
  parent_id         uuid references nodes(id) on delete restrict,
  -- 纯展示用途。**权限判定不区分 kind** —— 一个 space 节点也可以有正文,
  -- 一个 document 节点也可以有子节点。这是刻意的,见 §4.1 第 2 条。
  kind              text not null default 'document'
                    check (kind in ('space','document')),
  title             text not null default '未命名',
  position          integer not null default 0,      -- 同级排序
  materialized_path text not null default '',        -- '/<祖先id>/.../<自身id>'
  depth             integer not null default 0,
  -- 所有者。部门节点 = 部长(预置);二级节点 = 由部长任命;更深节点 = 创建者。
  -- 每一位"上级"对这个节点都拥有编辑权与授权权,判定方式见 §5.2。
  owner_id          uuid not null references users(id),
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

create index nodes_tree_idx  on nodes (parent_id, position);
create index nodes_path_idx  on nodes (materialized_path text_pattern_ops);
create index nodes_alive_idx on nodes (parent_id) where deleted_at is null;
create index nodes_owner_idx on nodes (owner_id);

-- ---------------- 组织归属(多归属) ----------------
-- 一个人可以同属多个部门 / 组 / 项目。这既是"他的位置",也是**授权范围**的依据(§5.3 规则三)。
create table org_assignments (
  user_id    uuid not null references users(id) on delete cascade,
  node_id    uuid not null references nodes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, node_id)
);

create index org_assignments_node_idx on org_assignments (node_id);

-- ---------------- 显式授权名单 ----------------
-- 对应「组长想再加一个人改」。**只有加法,没有 deny** —— 收回权限 = 删掉这里的行。
create table node_grants (
  node_id    uuid not null references nodes(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  granted_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (node_id, user_id)
);

-- ---------------- 正文 ----------------
create table node_contents (
  node_id         uuid primary key references nodes(id) on delete cascade,
  content_json    jsonb not null default '{"type":"doc","content":[]}'::jsonb,
  ydoc_snapshot   bytea,                    -- 阶段二启用,阶段一保持 null
  text_for_search text not null default '', -- 由 content_json 抽出的纯文本
  updated_at      timestamptz not null default now()
);

create index node_contents_trgm_idx
  on node_contents using gin (text_for_search gin_trgm_ops);

-- ---------------- 评论(全员可发,见 §5.4) ----------------
create table comments (
  id         uuid primary key default gen_random_uuid(),
  node_id    uuid not null references nodes(id) on delete cascade,
  parent_id  uuid references comments(id) on delete cascade,  -- 一层回复
  user_id    uuid not null references users(id),
  body       text not null,
  status     text not null default 'open'
             check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
  -- 阶段二会新增 anchor_type / anchor_text / anchor_pos 三列
);

create index comments_node_idx on comments (node_id, created_at);

-- ---------------- 审计日志 ----------------
create table audit_logs (
  id          bigserial primary key,
  actor_id    uuid references users(id),
  action      text not null,          -- node.create / node.move / grant.add ...
  target_type text not null,
  target_id   text not null,
  detail      jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);

create index audit_created_idx on audit_logs (created_at desc);
```

**作废的三张表**(老库里删掉):`spaces`、`space_members`、`page_permissions`。
`pages` / `page_contents` 分别改名为 `nodes` / `node_contents`,**结构本身沿用**(物化路径、version 乐观锁、软删除三套机制一行没改)。

### 4.3 字段级说明(几处反直觉的地方)

| 位置 | 说明 |
|---|---|
| `nodes.materialized_path` | 移动节点时必须**递归重建整棵子树**的路径。只改自己的路径,所有子孙都会失效 —— 而权限判定(§5.2)完全依赖这条路径,所以失败是**静默越权或静默失权**,不会立刻报错。 |
| `nodes.parent_id` 用 `on delete restrict` | 不允许物理删除有子节点的节点,强制走软删除流程。 |
| `nodes.owner_id` 是 `not null` | 每个节点**必须**有所有者。一级节点(部门)由组织架构预置;用户新建节点时默认为创建者本人。没有"无主节点"这种状态。 |
| `nodes.kind` 不参与权限判定 | 它只决定图标与默认展开行为。任何一个 space 节点都可以有正文,任何一个 document 节点都可以有子节点。**不要**在权限代码里对 kind 做分支。 |
| `node_contents.ydoc_snapshot` | 阶段一保持 `null`,但**字段先建好**。这就是"按协同的地基写代码"。 |
| `node_grants` 没有 deny 列 | 刻意如此。新模型里"拒绝"这个动作不存在:能改的人天然能改(祖先链所有者),被授权的人靠删行收回。**不要**为了"对称"补一个 deny 列 —— 它会让判定逻辑重新长出分支。 |
| `org_assignments` 是多对多 | 一个人同属多个组是常态。它同时承担两个职责:①展示"这个人在组织里的位置";②界定**授权范围**(§5.3 规则三)。 |
| `comments` 无 anchor 列 | 刻意如此,见 §4.1 第 8 条。 |
| `node_contents.content_json` 是 `jsonb` | ⚠️ **jsonb 不保留键的书写顺序**(按内部规范序存储)。实测:同一个文档写进去再读回来,`JSON.stringify` 的结果与原文不同,但语义完全一致。所以**任何判断正文是否变了的逻辑都必须按语义比,不能比字符串** —— 我们的冲突检测用 `updated_at` 而不是内容哈希,恰好绕开了这个坑;将来若加「内容没变就不写库」的优化,必须用规范化后的比较。 |
| `users.employee_no` 是**登录标识** | v2.2 起取代邮箱。用 `text` 而非数字类型:工号常带字母前缀或前导零(`KC2026007`),当成数字存会丢信息。唯一性由数据库约束保证,不在应用层判重。 |
| `users.must_change_password` | 新账号一律 `true`。它不只是"提示用户去改密码"—— **它是服务端拦截的依据**(见 §6.1.2)。**不要把它做成纯前端状态**,那等于没有。 |
| `users.status` 有三档 | `active` 在职 / `disabled` 账号被停用 / `departed` **已离职**。**离职与停用不是一回事**:离职是人事状态(人不在公司了),停用是账号状态(还在公司但账号被封)。用户明确要求离职人员在**他自己创建的页面**上也要标出来 —— 前端在节点与评论的作者名旁显示「已离职」,历史记录不抹掉。 |
| `users.is_super_admin` 不参与内容权限 | 它只是"能维护组织架构"的开关。**新模型里没有超管旁路** —— 一个超管要编辑某篇文档,同样得是它的所有者/祖先所有者/被授权者。这条与旧设计不同(旧设计里超管直通),务必注意。 |
| 三个"手写"索引 | 其中**两个可以表达进 schema**:`nodes_path_idx` 用 `ops: raw("text_pattern_ops")`,`node_contents_trgm_idx` 用 `type: Gin` + `ops: raw("gin_trgm_ops")`。**这一点很要紧**:凡 schema 里没声明的索引,`prisma migrate dev` 会生成 `DROP INDEX` 把它删掉 —— 若删掉三元组索引,中文检索会静默退化成全表扫描。只有 `nodes_alive_idx`(部分索引)Prisma 不管理、也不会删,仍需手写。另:`nodes_path_idx` 的 ops 与 Prisma 内省结果无法完全对齐,漂移检测会输出一对无害的 drop+create(定义相同),不要误判为故障。 |

---

## 5. 权限模型

> **v2.0 整体重写。** 旧模型是"五档角色 + 逐层继承 + deny 优先"。新模型里**没有角色等级**,只有三种关系与三个判定问题。原「四条铁律」保留其中两条的精神,删掉两条。

### 5.1 三个概念

这是全部。理解这三个,就理解了权限模型。

| 概念 | 是什么 | 从哪来 |
|---|---|---|
| **所有者**(owner) | 一个节点的负责人。**每个节点必有且仅有一个。** | 部门节点 = 部长(组织架构预置);二级节点 = 由部长任命;更深节点 = 创建者本人 |
| **组织归属** | 某人"在组织里的位置"。**多归属**,一个人可同时属于多个部门 / 组 / 项目 | 全员预置,随组织架构导入 |
| **显式授权** | 某人被单独允许改某个节点 | 由有授权权的人手动授予 |

**层级形态:**

```
部门(一级节点 · 所有者 = 部长)
 ├─ 组 / 项目(二级节点 · 所有者 = 部长任命)
 │   └─ 子空间 / 子页面(所有者 = 创建者)
 │       └─ …(深度不限)
 └─ 文档(部门直属页面 —— 与二级节点并存)
```

**组织形态到二级为止**(公司 → 部门 → 组/项目),这是公司的实际结构。但**技术上不限制深度**:二级节点下面再建子空间还是子页面,由使用者自己决定,系统一视同仁。

### 5.2 判定逻辑

整个权限模型只有三个函数,按顺序回答三个问题:

```ts
// packages/shared/src/permission.ts

/** 能读吗? —— 已登录即可。全员开放,没有任何例外与分支。 */
function canRead(user: Actor, node: NodeView): boolean {
  return true;
}

/** 能改吗? —— 满足任一即可。 */
function canEdit(user: Actor, chain: Chain, grantUserIds: Set<string>): boolean {
  // 1) 我是这个节点的所有者(部门直属页面 → 部长;A 建的 → A 自己)
  if (user.id === chain.self.ownerId) return true;

  // 2) 我在祖先链的**任一**节点上是所有者
  //    —— 这就是「A 建的东西,A 的领导、上层领导都能改」
  if (chain.ancestors.some((n) => n.ownerId === user.id)) return true;

  // 3) 我被显式授权
  return grantUserIds.has(user.id);
}

/** 能管吗(决定这个节点还有谁能改)? —— 1 或 2,但授权动作另受组织范围约束(§5.3 规则三)。 */
function canManage(user: Actor, chain: Chain): boolean {
  return user.id === chain.self.ownerId || chain.ancestors.some((n) => n.ownerId === user.id);
}
```

`chain` 由物化路径一次查出(根 → 自身),不需要递归查询:

```sql
-- 一条查询拿到整条祖先链及其所有者
select id, parent_id, owner_id, depth, title
  from nodes
 where materialized_path like (
   select materialized_path || '%' from nodes where id = $1
 )
   and deleted_at is null
 order by depth;
```

### 5.3 三条定稿规则

| 规则 | 含义 | 为什么 |
|---|---|---|
| **读无条件开放** | 所有节点对所有登录用户可读,不设门槛 | 取代旧「最小可见」铁律。知识库的价值在于共享,公司内部文档本就不该藏 |
| **编辑权沿祖先链继承,且不可被拒绝** | 上层所有者天然能改下层的一切;没有 deny,没有"某人不许改" | 管理链条上的每一级都要能介入下属的内容。收回权限的唯一手段是**从授权名单里删行** |
| **授权受组织范围约束** | 操作者只能授权给**落在自己组织范围内**的人 | 防止横向越权:组长不该能把权限给到别的部门的人 |

**规则三的"组织范围"定义:**

```
orgScope(user) = 该用户所有 org_assignments 指向的节点及其全部后代
```

判定一个候选被授权者 `target` 是否可被授予:

```
target ∈ orgScope(操作者)
  ⟺ 存在一条 org_assignments(target, N),使得 N == 操作者的某个归属节点 N0
     或 N 在 N0 的子树里
```

**这条规则为什么必要 —— 用一个具体例子说明:**

组员 A 属于「后端组」。A 在组下建了子空间 S,A 是 S 的所有者,因此 A **能**给 S 授权。
但 A 的 `orgScope` 只有「后端组」这一支,所以他**只能把 S 的编辑权给后端组里的人** ——
他无法把权限给市场部的人,也无法给同部门的「前端组」的人。

部长的 `orgScope` 是整个技术部,所以部长能往技术部任何位置授权。
**范围自下而上自然放大,不需要单独维护"谁的权限更大"。**

#### 与旧模型的两条"删除"

原 §5.3 的四条铁律里,以下两条**在新模型中不成立**,实现时不要照搬:

| 旧铁律 | 现状 |
|---|---|
| 「拒绝优先」(deny 短路) | **删除。** 新模型没有 deny,编辑权不可被拒绝 |
| 「最小可见」(无权限的页面根本不出现) | **删除。** 读是全员开放的,列表与检索**不做权限过滤** |

保留的两条:继承(编辑权沿祖先链向上取)、就近覆盖的**反向**表达 ——
新模型里"越靠上权限越大",与旧模型"越靠下越具体"正好相反。这是一个容易写反的地方。

### 5.4 能力对照

| 动作 | 谁能做 |
|---|---|
| 浏览任意节点 | **所有登录用户** |
| 发表 / 回复评论 | **所有登录用户**(全员可评论) |
| 标记评论已解决 | 评论作者本人,或该节点的任一祖先所有者 |
| 删除评论 | 评论作者本人,或该节点的任一祖先所有者 |
| 在二级节点下新建页面 | 在该节点上 `canEdit` 的人;**组员只能在自己所属的节点下新建** |
| 新建子空间 | 同上(技术上不区分 kind) |
| 编辑正文 / 改标题 | `canEdit` |
| 移动 / 同级排序 | `canEdit` |
| 移入回收站(软删除) | `canEdit` |
| 从回收站恢复 | `canEdit` |
| **彻底删除**(不可逆) | **祖先链所有者**(不含"仅被授权者" —— 门槛刻意高于软删除) |
| 授权 / 收回(增删名单) | `canManage`,且被授权者须在操作者组织范围内 |
| 任命 / 变更二级节点的所有者 | 该节点的**祖先所有者**(即部长) |
| 维护组织架构(建部门 / 导人员 / 设归属) | `is_super_admin` |
| 查看审计日志 | 祖先链所有者,或 `is_super_admin` |

**两处值得单独说明:**

1. **"组员只能在自己所属的节点下新建"** 这条与 `canEdit` 是两件事:一个组员对「后端组」节点本身没有 `canEdit`(他不是所有者、也不在祖先链上),但他**有权在它下面新建** —— 新建出来的节点归他所有。判定新建时用的不是 `canEdit(父节点)`,而是一条单独的规则:
   `canCreateUnder(user, parent)` = `canEdit(user, parent)` **或** `parent ∈ orgScope(user)`。
2. **彻底删除比软删除严。** 被授权者能改能删(可恢复),但不能彻底销毁。这延续了旧设计里"不可逆操作门槛更高"的判断。

### 5.5 缓存与失效

- 判定结果写入 Redis,key 形如 `kc:perm:{generation}:{userId}:{nodeId}`,**TTL 30 秒**。
- **`generation` 按一级节点(部门)分片**:`kc:perm:gen:{rootNodeId}`。
  组织变更天然以部门为边界,变更范围与失效范围一致。
- 触发 `INCR` 的事件:**所有者变更、授权名单增删、组织归属变更**。
- 「变更最迟 30 秒生效」是**上限**,不是常态。
- **Redis 是可降级依赖**:连接失败或取不到世代号时一律回源数据库,
  判定的**正确性不依赖缓存可用性**(与 §3.2「Redis 不作为唯一数据源」一致)。

**为什么不做细粒度失效**(与旧设计同一判断,理由更充分了):

新模型里一次判定要读**整条祖先链的所有者**,链上任一节点的所有者变更都会影响结果。
用 `materialized_path` 前缀 `SCAN` 批量删 key 的老办法,在这里需要"向上"失效(祖先变了,所有后代都受影响),
范围比旧模型更大、更容易漏。**漏的表现是"权限已经改了,但某个人还能改" —— 静默越权。**
按部门分片的世代号只有一处状态、一次 `INCR`,不存在漏删。

---

## 6. 接口设计

### 6.1 通用约定

- 前缀 `/api/v1`,全部返回 JSON。
- 认证:HttpOnly Cookie 承载**不透明会话 id**,不用 localStorage 存 token。会话的存储位置与理由见 §6.1.1。
- 错误体统一:

```json
{ "error": { "code": "FORBIDDEN", "message": "你没有编辑该节点的权限" } }
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登录或会话过期 |
| `FORBIDDEN` | 403 | 已登录,但对这个节点没有该操作的权限 |
| `NOT_FOUND` | 404 | 资源**确实不存在** |
| `VALIDATION_FAILED` | 400 | 参数校验失败 |
| `VERSION_CONFLICT` | 409 | 乐观锁冲突,客户端需重新拉取 |
| `RATE_LIMITED` | 429 | 触发限流 |

> **v2.0 起不再用 `NOT_FOUND` 掩盖"无权访问"。** 读是全员开放的,不存在"存在但读不到"的资源,
> 所以没有什么需要掩盖的。写操作被拒时回 `FORBIDDEN` 是更有用的回应 ——
> 用户需要知道"东西在那儿,只是你不能改",而不是被误导成"它不存在"。
> (v1.x 那条"用 404 掩盖存在性、以防枚举别人文档 ID"的理由,在新模型下不再成立。)

- 分页:评论与审计日志用游标分页(`?cursor=&limit=`);组织树一次性返回整棵(**不做过滤**,理由见 §8.3)。
- **请求体上限 8MB**(`app-setup.ts` 的 `BODY_LIMIT`)。
  ⚠️ Express 的 JSON 解析器默认只有 **100kb**,而正文上限是 2MB ——
  不显式抬高的话,长文档保存会被 body-parser 直接拒掉,表现成「短文档正常、长文档存不进去」。
- body-parser 的解析错误**不是** `HttpException` 的子类(只带 `status` / `type` 属性),
  异常过滤器必须显式识别,否则「请求体过大」会变成 **500** —— 而它明明是客户端的问题,
  500 会把排查方向引向服务端。现在统一映射成 `VALIDATION_FAILED` 并给出可读文案。
- 请求体解析走 Nest 的 `useBodyParser()`,**不从 `express` 里 import `json()`**:
  express 只是 `@nestjs/platform-express` 的传递依赖,直接 import 在本地能跑,
  进了镜像就是 `ERR_MODULE_NOT_FOUND`(实测踩过)。

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

### 6.1.2 密码策略与首次登录改密(v2.5 重做)

用户决定:**新账号统一初始密码 `123456`**,密码**不进 Excel 模板**(由服务端内置),
**首次登录强制改密**。

#### 两条规则

| | 规则 |
|---|---|
| 初始密码 | 固定 `123456`。建号时由服务端写入,**模板里没有密码列** |
| 新密码要求 | **至少 8 位**,且**必须同时包含字母与数字** |

#### ⚠️ 首次登录**不建立会话**(v2.5 重新设计)

用户的原话:

> 「重置密码,不需要输入原密码,直接输入新密码。还有一点,用户在初次登录页面以后,
> 无法回到 login 页面,必须改密码才行,这样是不合适的,**用户第一次登录,不应该记录登录状态**,
> 重置完密码以后,应该要用户重新登录才对,你的逻辑出问题了。」

v2.2 的做法是「照常登录 + 守卫拦住所有接口 + 白名单放行改密页要用的那几条」。
它能挡住越权,但造出了一个**谁都不想要的状态**:那个人既进不去系统
(每条业务接口都 403),又退不出去(连登录页都回不去,因为"已经登录"了)。

现在改成:

```
POST /auth/login
  ├─ 常规               → 建立会话,下发 Cookie,响应 kind = 'session'
  └─ mustChangePassword → **不建立会话、不下发 Cookie**
                          响应 kind = 'password-change-required' + setupToken
                                     ↓
POST /auth/initial-password  { setupToken, newPassword }   ← 公开接口,**不要原密码**
  └─ 成功 → 204,**仍然不建立会话**
                                     ↓
                       用户用新密码重新登录一次(这时才 kind = 'session')
```

四条由此而来的性质:

1. **改密之前,这个人没有登录状态** —— 他对业务接口而言就是未登录(401)。
   注意**不是 403**:403 意味着"你登录了但没权限",而事实是他压根没登录。
2. **不需要"改密白名单"了。** 白名单是为了让"已登录但未改密的人"能碰到改密页;
   现在不存在这种状态,整套机制连同 `@AllowDuringPasswordChange()` 装饰器一起删掉。
   顺带消掉一类 bug:白名单漏一条,用户就会卡在某个页面上(v2.0 就漏过 `GET /auth/me`)。
3. **改密不要原密码。** 登录那一步已经用初始密码验过身份,再要一次是重复。
   代替它的是那张 `setupToken`。
4. **改完必须重新登录。** 这样"我设的密码真的能用"是**当场验证**的,
   而不是等他下次来才发现打错了。

> **登录是"两种结果",不是"成功/失败"两种。** 这一点在类型上就写死了
> (`LoginResponse` 是判别联合),所以前端不可能"忘记处理首登"——
> 它会直接编译不过。

#### 一次性凭证(`setupToken`)

| | |
|---|---|
| 形式 | `base64url(payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))` |
| 内容 | 只有 `sub`(用户 id)与 `exp`(毫秒时间戳)—— **不放工号、不放密码** |
| 有效期 | **10 分钟** |
| 存储 | **服务端不存**。无状态签名,进程重启也不影响手上这张 |
| 一次性 | **不需要服务端记"用过了"** —— 改密成功会把 `must_change_password` 翻成 `false`,而校验时会检查这个标志。**状态本身就把凭证作废了** |

> **为什么不放 Redis**:Redis 在这个系统里是**可降级依赖**(权限缓存没了也能正常判定)。
> 把"首次改密"这条必经之路挂在 Redis 上,等于给登录链路凭空加一个可用性约束。
> 数据库则要加表、加清理任务。签名方案两者都不需要。
>
> **为什么不降级**:`SESSION_SECRET` 未配置时,`login` / `setInitialPassword`
> 直接报 `INTERNAL_ERROR`,**绝不用空密钥签**。空密钥签出来的凭证任何人都能伪造 ——
> 那比"首登改密暂时不可用"严重得多。

#### 守卫里保留了一条纵深防御

按上面的流程,"有会话但还待改密"这个状态**不可能出现**。守卫仍然检查它:
一旦发现,就**吊销该会话并按未登录处理**。

这不是多余 —— 它挡的是"有人手工改库"这类绕过流程的情况,
而处理方式是让那个状态**不可能存在**,而不是放进来再逐个接口去判。
(v2.2 正是"放进来再判",还因此漏过一次白名单。)

#### 已知风险(写在这里,不藏)

**初始密码全员相同,意味着在某人首次登录改密之前,任何知道他工号的人都能登进他的系统。**
三条缓解措施都已落实:

- 首次登录**强制**改密,且**服务端拦截** —— 他拿不到任何业务数据
- 改密之前**没有任何登录状态** —— 连业务接口都是 401
  (而不是"登进去了但什么都看不到"那种半状态)
- **工号列表不对未登录用户暴露**;登录失败一律回同一个错误,不区分"工号不存在"与"密码错误"

> 若要更严,可改为"管理员生成一次性激活码"模式(记在 §11.3)。但阶段一按用户要求:
> **统一初始密码 + 首登强制改密**。

#### 与 BCrypt 的关系

- 密码上限仍是 **72 字节**(bcrypt 会静默截断,M2 已加校验)。8 位的要求远低于此,不冲突。
- 强度校验**只在改密接口做**。登录时**不做**强度校验 —— 否则一旦收紧规则,老账号会直接登不上。
- 两条改密路径(`/auth/initial-password` 与 `/auth/change-password`)都调**同一个**
  `checkPasswordStrength`,不各写一份正则 —— 两处规则不一致的表现是
  "某个入口能设出不合规的密码",而且不会报错。

### 6.1.4 管理员重置密码(v2.6 补)

**这是在 v2.5 之前根本不存在的能力** —— 也就是说,在那之前系统里没有
"同事忘了密码"的出口。唯一的办法是运维登进容器、连上数据库、手工改哈希。
那既不该是运维的活,也**不留任何痕迹** —— 而"谁能登进这个账号"是最该留痕的事之一。

#### 一次重置做三件事,少一件都会留下说不清的状态

| # | 动作 | 漏掉的后果 |
|---|---|---|
| 1 | 哈希写回内置初始密码 `123456` | — |
| 2 | `must_change_password = true` | 等于**永久**把密码设成了 `123456` |
| 3 | **吊销他的全部会话** | 他手上那个标签页还能继续用,而管理员以为"他已经进不来了" |

第 3 条最容易被当成多余的 —— 它其实才是"重置"这个词在管理员心里的真实含义。
实测踩过同类(改密码不清会话),表现是「改完密码旧标签页还能用」,看着像没生效。

#### 两条刻意的拒绝

- **不能重置自己。** 能点到那个按钮,说明他已经登进来了 —— 能登进来的人不需要
  重置自己。允许它只会制造一次手滑:他立刻被踢下线,然后用 `123456` 登回来、
  还得再改一遍密码。想改自己的密码走「修改密码」。
- **不能重置「已离职 / 已停用」的人。** 重置了也登不进来(守卫按 `status` 拦),
  白做工且会让人以为"重置了怎么还是登不上"。错误信息直接点出真正的原因:
  「要先把他改回在职」。

#### 为什么不去作废"已签发的一次性凭证"

重置一个**还没激活**的账号时,他上一步拿到的 `setupToken` 在 10 分钟内仍然可用。

这**不构成额外暴露**:他能拿旧凭证改密码,也能拿 `123456` 重新登一次换张新的 ——
未激活账号的初始密码本来就等同于公开信息,而那正是这套强制改密机制存在的前提
(§6.1.2「已知风险」)。为了它引入"凭证版本号",等于给认证主链路加一条
谁都不敢动的耦合,换不来任何实际的安全收益。

真正需要收回的东西(**已发出的会话**)重置是收回了的。

#### ⚠️ 顺带修掉的一处判权缺口

加 `mustChangePassword` 这个字段时才发现:`GET /admin/users` **此前根本没有判权** ——
任何登录用户都能拿到全公司名册,而文档一直写的是超管。那个字段等于一份
**"谁的密码还是 123456"的目标清单**,对非管理员绝不该可见。

现在它按文档收紧了(超管专属)。那"这个部门里有谁"要不要公开?**要** ——
但它走的是 `GET /nodes/:id/members`(v2.4,读全员开放)。
公开的是**组织归属**,不是账号状态与登录时间。

前端 `/admin/*` 也补了一层 `RequireSuperAdmin`,但那**只是体验**:
非管理员手工敲地址时看到一句人话,而不是一屏 403 报错。判权仍在服务端。

### 6.2 接口清单

> ✅ 本节与代码的**双向**一致性由 `pnpm audit:docs` 校验(见 §0.5)——
> 接口加了没写进来、或写了但代码里没有,都会让 `pnpm check` 失败。

权限列的取值现在都是**关系**,不再是角色:v2.0 起写 `canEdit` / `canManage` / `祖先所有者` / `超管` / `登录(全员)`。

#### 认证

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | — | 登录。**两种结果**(v2.5):常规 → 下发会话 Cookie;`mustChangePassword` → **不下发 Cookie**,只给一张一次性 `setupToken` |
| POST | `/auth/initial-password` | — | **首次改密**。凭 `setupToken`,**不需要原密码**;成功后**也不建立会话**,用户要用新密码重新登录 |
| POST | `/auth/change-password` | 登录 | **已登录用户**主动改密。需要当前密码(会话可能被他人接管) |
| POST | `/auth/logout` | 登录 | 登出 |
| GET | `/auth/me` | 登录 | 当前用户 + **组织归属列表** |
| POST | `/auth/setup` | — | **仅当库中无用户时可用**,创建首个管理员(工号 + 姓名 + 密码) |
| GET | `/auth/setup-state` | — | 返回 `{ required: boolean }`,供前端 `/setup` 判断该显示引导页还是登录页 |

> v2.0 起 `/auth/me` **不再返回"可见空间列表"** —— 所有节点对所有登录用户可见,没有"可见子集"这回事。
> 前端拿到的是"我是不是某些节点的所有者 / 我的组织归属在哪",用于决定界面上的操作开关(服务端仍是唯一裁判)。
>
> v2.5 起 `/auth/me` 也**不再返回 `mustChangePassword`** —— 能拿到这个响应就说明会话已建立,
> 而首登不发会话,所以它在前端恒为 `false`。留一个永远为假的字段只会让人以为它还有用;
> 服务端自己需要这个判断(守卫的纵深防御),用的是内部的 `SessionUser`。

#### 组织架构

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/org/tree` | 登录 | 整棵节点树(组织与内容合一)。**全员可得全部,不做过滤** |
| GET | `/org/tree?root=<id>` | 登录 | **只返回那棵子树**(v2.4)。`root` 不存在或已删 → 404,**不静默返回空树** |
| GET | `/org/scopes` | 登录 | 组织范围下拉数据:一级 / 二级节点的路径 + 该范围内的人数 |
| POST | `/org/nodes` | 超管 / 祖先所有者 | 建部门(`parentId` 为空,超管)或建组(部长)。`parentId` 为空时必须指定部长为所有者 |
| GET | `/nodes/:id/owner-candidates` | 祖先所有者 / 超管 | 能担任该节点所有者的人选(**已按操作者组织范围过滤**) |
| PATCH | `/nodes/:id/owner` | 祖先所有者 / 超管 | 任命 / 变更所有者(部长任命组长走这里)。**一级部门只有超管能改** |
| GET | `/nodes/:id/members` | 登录 | **这个节点下都有谁**(v2.4)。分「直接成员 / 下属成员」两段,带 `canManage` |
| GET | `/nodes/:id/member-candidates` | 该节点所有者 / 超管 | 能加进该节点的人(**已按操作者组织范围过滤**;超管不受范围限制) |
| POST | `/nodes/:id/members` | 该节点所有者 / 超管 | **追加**一条组织归属。幂等;受组织范围约束 |
| DELETE | `/nodes/:id/members/:userId` | 该节点所有者 / 超管 | **移出**一条组织归属 —— 调岗两步的第二步 |
| GET | `/admin/users?q=` | **超管** | 人员列表。带 `mustChangePassword`,界面据此标「初始密码未改」 |
| POST | `/admin/users` | 超管 | 建人(**预置,不是注册**) |
| POST | `/admin/users/:id/reset-password` | 超管 | **把密码打回初始值**(v2.6)。同时置 `must_change_password = true` 并**吊销他全部会话**。见 §6.1.4 |
| PATCH | `/admin/users/:id/assignments` | 超管 | 设置组织归属(多归属,**整表替换**) |
| PATCH | `/admin/users/:id` | 超管 | 改姓名 / **状态**(`active` / `disabled` / `departed`) |
| GET | `/admin/org/import-template` | 超管 | 下载组织架构 `.xlsx` 模板(**带当前全部人员与节点**,不是空表) |
| POST | `/admin/org/import?dryRun=1` | 超管 | 上传并**只返回差异预览**,不写库 |
| POST | `/admin/org/import` | 超管 | 确认写入(一次事务;任何一行失败整批回滚)。**新建账号一律用内置初始密码 `123456`,并置 `must_change_password = true`** |

> **成员与授权是两条接口、两套门槛,v2.4 起刻意不合并。**
> 「成员」管的是**组织归属**(他在哪个部门 / 组),「授权」管的是**判定结果**(他能改什么)。
> 前者的写权限是 `canManage` **或超管**(组织架构本就归超管管,而且他的组织归属
> 可能是空的,过不了范围检查);后者是 `canManage`,**超管不在其列**
> (他不是内容所有者,不该改别人的内容权限)。
> 合成一条接口就会出现「超管能改成员、但候选列表是空的」这种自相矛盾的界面。

#### 节点

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/nodes` | `canCreateUnder` | 新建(带 `parentId` / `kind`),服务端计算 `materialized_path` |
| GET | `/nodes/:id` | 登录 | 单节点元信息 + 祖先链 |
| PATCH | `/nodes/:id` | `canEdit` | 改标题 / 状态,带 `version` |
| POST | `/nodes/:id/move` | `canEdit` | 拖拽排序与改父级,**递归重建子树路径** |
| DELETE | `/nodes/:id` | `canEdit` | 软删除,级联标记子树 |
| GET | `/nodes/:id/content` | 登录 | 取正文 |
| PUT | `/nodes/:id/content` | `canEdit` | 存正文,同步重算 `text_for_search` |

#### 授权(替代原「页面权限」)

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/nodes/:id/grants` | 登录 | 三段授权视图(所有者 / 上级所有者 / 显式名单)+ `canManage` |
| GET | `/nodes/:id/grant-candidates` | `canManage` | 可授权的人(**已按操作者组织范围过滤**);无管理权时返回空数组 |
| PUT | `/nodes/:id/grants` | `canManage` | 整表替换。**逐个校验被授权者在操作者组织范围内**,越界拒绝 |

> 注意这里**只有名单,没有 deny**。收回权限 = 把人从名单里删掉。
> 候选人接口返回的列表已经过滤过,但**服务端在写入时仍要再校验一次** —— 前端的过滤只是便利,不是安全边界。

#### 评论

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/nodes/:id/comments` | 登录 | 评论列表 |
| POST | `/nodes/:id/comments` | 登录 | 发表评论或回复(带 `parent_id`)。**全员可发** |
| PATCH | `/comments/:id` | 作者 / 祖先所有者 | 标记已解决、重新打开、编辑正文 |
| DELETE | `/comments/:id` | 作者 / 祖先所有者 | 删除评论 |

#### 检索与治理

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/search?q=` | 登录 | 模糊检索。**不做权限过滤** —— 读是全员开放的 |
| GET | `/trash` | 登录 | 回收站,只列**我 `canEdit` 的**已删子树根 |
| GET | `/trash/policy` | 登录 | 回收站保留策略(保留天数 / 扫描间隔)。**界面文案取这里,不硬编码** |
| POST | `/admin/maintenance/trash-purge` | 超管 | 按保留策略立即清理一次(v2.4)。`?dryRun=true` 只列不删 |
| POST | `/nodes/:id/restore` | `canEdit` | 恢复(含整棵子树;原父不在树上时挂回顶层) |
| DELETE | `/nodes/:id/purge` | 祖先所有者 | 彻底删除(不可逆,只作用于回收站里的节点) |
| GET | `/nodes/:id/export?format=md` | 登录 | 导出为 Markdown(以 `text/markdown` 直接下载) |
| GET | `/comment-counts?ids=` | 登录 | 批量取未解决评论数(节点树角标) |
| POST | `/uploads` | 登录 | 上传图片,返回 `{ url }`;白名单 `.png/.jpg/.jpeg/.gif/.webp/.avif`(不含 SVG),单文件 ≤ 10MB |
| GET | `/audit-logs?cursor=&limit=` | 祖先所有者 / 超管 | 审计日志 |

#### 运维探针(**无需登录**)

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/health` | — | **存活**探针。只要进程还能响应就返回 200,刻意**不查依赖** —— 它回答的是"要不要重启这个进程",数据库挂了不该导致容器被反复杀掉 |
| GET | `/health/ready` | — | **就绪**探针。逐项报告 `database` / `redis`,依赖不全时返回 **503** 并指明是哪一个(用 `passthrough` 保留响应体只改状态码) |

> 整个控制器标 `@Public()`:探针不带凭证,容器编排也拿不到 Cookie。
> 这两个接口是**唯一**不需要登录的业务之外的接口
> (另两个是 `/auth/setup` 与 `/auth/setup-state`,它们只在库中无用户时有意义)。

#### 阶段二占位(不实现)

| 方法 | 路径 | 说明 |
|---|---|---|
| WS | `/collab?nodeId=&token=` | 握手时校验该节点的写权限(`canEdit`),无权限直接拒绝连接;只读用户标记 `readOnly`,服务端丢弃其 outgoing update |

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

| 路由 | 页面 | 谁能进 |
|---|---|---|
| `/login` | 登录(**工号 + 密码**) | — |
| `/change-password` | 首次登录强制改密 | 全员(未改密时唯一可达页) |
| `/setup` | 首次部署的管理员初始化(含组织架构导入) | — |
| `/` | **工作台 —— 登录后直达** | 全员 |
| `/n/:nodeId` | 节点页(主工作面) | 全员 |
| `/trash` | 回收站(只列我 `canEdit` 的) | 全员 |
| `/search` | 检索结果 | 全员 |
| `/admin/org` | 组织架构维护:建部门 / 任命所有者 | 超管 |
| `/admin/users` | 人员、归属、**重置密码** | 超管 |
| `/audit` | 审计日志 | 祖先所有者 / 超管 |
| `*`(其它任意地址) | 404 页(`NotFound`) | 全员 |

> 前 5 条(`/setup`、`/login`、`/change-password`)不需要登录外壳;
> 其余都在 `AppLayout` 里(顶栏 + 左树 + 主区)。`/admin/*` 外面还包了一层
> `RequireSuperAdmin` —— 它**只负责体验**(手工敲地址时看到一句人话而不是满屏 403),
> 判权始终在服务端。

**登录后直接进 `/`(工作台),不再有"空间列表"这一中间页。**
v1.x 的 `/spaces` 与 `/s/:spaceId/members` 两条路由作废,`/s/:spaceId/p/:pageId` 简化为 `/n/:nodeId`。

左侧是**完整的组织与内容树**(全员可见全部),主区是编辑器,右侧是上下文面板(目录 · 评论)。

> **权限设置从"独立页面"改成节点上的弹窗。** 授权是节点级的动作(§6.2 的 `/nodes/:id/grants`),
> 而节点会有几百个,不可能每个都配一个页面。这与 v1.x 把成员管理做成 `/s/:spaceId/members` 页面是两种做法。
>
> **树顶不设"公司"节点。** 一级节点就是部门,直接并排展示 —— 多一层"公司"会让每个用户每次都要多点一次才能展开。

**v2.4:节点上有两个弹窗入口,刻意分开。**

树行悬停时有两个按钮(都是 `canManage` 才出现,超管对一级部门另放行):

| 按钮 | 弹窗 | 管什么 |
|---|---|---|
| ⚙ | 权限 | **判定结果** —— 谁能改这个节点(所有者 / 上级所有者 / 额外授权三段) |
| ☰ | 成员 | **组织事实** —— 这个节点下都有谁(直接成员 / 下属成员两段) |

合并成一个带 Tab 的弹窗会更省地方,但没有这么做 —— 两者混在一起会让
「移出成员 = 收回权限」变成一种反复出现的误解。它们是两件事:

- 移出归属**不改变所有权**:被移出的组长仍然是组长,该能改的还是能改;
- 但**会缩小他的组织范围**:他能授权给别人的人变少了;若是他最后一条归属,
  他将不能在别人下面新建、也不能被授权。

这两句写在移出前的确认框里,而且有单测钉住(`removal-note.test.ts`)——
它们是这件事的安全边界,漏了或写反了会让人照着错误的心智模型做人事调整。

### 7.3 状态管理

- 服务端状态:TanStack Query(缓存、失效、重试都交给它)。
- 本地 UI 状态:Zustand(侧栏折叠、当前 Tab 之类)。
- **不引入 Redux** —— 这个规模用不上。

### 7.4 编辑器与文档模型

- Tiptap 配置为输出 ProseMirror JSON,`content_json` 列的格式与之**逐字节对应**。
- 阶段二接协同时,`y-prosemirror` 的 `XmlFragment` 与这个 JSON 结构是 1:1 映射的,不需要改存储层。这就是现在把模型定对的价值。
- **禁用编辑器自带的撤销栈之外的问题**:阶段一用自带的即可;阶段二挂 Yjs 时必须关掉它并改用 `Y.UndoManager`,否则会有两套撤销栈打架。这一条写在第 10 节。

**实现要点(v1.7 补)**

- 编辑器用 Tiptap 3。**扩展包必须声明为直接依赖**:`@tiptap/core`、`@tiptap/pm`、
  `@tiptap/extensions`(v3 的 `Placeholder` 在这里,不再是单独的 `extension-placeholder`)。
  只靠 `starter-kit` 的传递依赖会让命令增强(`toggleBold` 之类)在类型层全部丢失。
- **`content` 只在挂载时读一次**。父组件用 `key={pageId}` 控制重建,而不是靠 props 更新 ——
  每次服务端返回新内容就 `setContent` 会把正在打字的人的光标顶走、输入被吞。这是
  「自动保存 + 受控内容」最经典的坑。
- 工具栏按钮**必须拦 `mousedown` 并 `preventDefault()`**。用 `onClick` 会先丢焦点、
  选区随之消失,于是「选中一段再点加粗」什么都不发生。
- 自动保存防抖 1200ms;正文的冲突检测用 `baseUpdatedAt`(见 §6.2 的 `PUT /content`),
  **不用 `nodes.version`** —— 那个号被改名/移动共用,耦合的结果是「改正文让改名冲突」。
  冲突时**不自动覆盖**,显示横幅让用户自己决定重新加载。
- 大纲(右栏目录)从 `editor.getJSON()` 里抽 1~3 级标题,与工具栏能插入的层级一致;
  这样序号能对上正文里的 `h1/h2/h3`,点击跳转靠 `scrollIntoView`。
- 编辑器正文样式**不用 `@tailwindcss/typography`**:它面向博客正文,表格边框、
  代码块底色、空单元格可点击这几件事都不管。手写约 30 行 CSS 更直接,也不会因插件升级走样。

#### 工具栏的三件"上下文相关"控件(v2.10)

用户实测反馈了三件事,它们有一个共同点:**控件本身没问题,是"做不成事"**。

| 反馈 | 真正缺的东西 |
|---|---|
| 「添加链接竟然是弹窗输入链接,这个不太对」 | 一个能同时填**地址 + 显示文字**、能校验、能回填的表单 |
| 「表格默认三行三列,不支持扩展」 | 行列的增删(以及合并、表头) |
| 「代码块不支持语言能力指定」 | 语言属性 + 语法高亮 |

**链接:换成贴着按钮展开的气泡。** `window.prompt` 除了观感,有三件事**做不到**:
只有一个输入框(定地址和定文字要分两次)、不能校验(`javascript:` 会直接写进文档)、
编辑已有链接时看不到原文。地址归一化抽成纯函数 `link-url.ts` 并有单测 ——
其中最容易做错、也最难发现的一条是:**站内路径(`/n/…`)与 `#锚点` 绝不能补 `https://`**,
补了会把"跳到另一篇文档"悄悄改成"跳到外网站点",而且**不报错**。

**表格:能力收进一个按钮,而不是铺一排按钮。** 要补的操作有十来个(前后左右插行列、
删行列、合并、拆分、表头、删表),铺成一行在这个布局里放不下 ——
正文列只有 `1084 - 320(左树) - 320(右栏) ≈ 444px`,v2.8 已经因为折行踩过一次。
所以做成**一个按钮两种状态**:不在表格里时只做"插入"(带 6×6 网格选行列数);
光标进了表格,同一个按钮高亮,菜单里多出「表格工具」一组。
`合并 / 拆分` 用 `editor.can()` 判断可用性并给出**说明为什么不可用**的 title
(「先用鼠标拖选两个以上单元格」),而不是让按钮静默失效。

**代码块:语言属性 + 低亮语法高亮。** 三处要点:

1. **必须关掉 StarterKit 自带的 `codeBlock`**(`codeBlock: false`),再挂
   `CodeBlockLowlight` —— 同一个节点两份实现会冲突,表现是"语言存不住、类名时有时无"。
2. **语言清单与高亮注册表必须是同一份数据。** 下拉里有、注册表里没有 =>
   选了语言却不着色,**而且不报任何错**。所以注册表由 `CODE_LANGUAGES` **推导**出来
   (`lowlightRegistry()`),并有单测断言"每个 id 与别名都真的注册过"。
3. **原始语言不能直接交给 lowlight。** 实测确认:它对未注册的语言**抛错**
   (`Unknown language: xxx`),不是"原样返回不报错"。一篇从别处粘进来、
   带 ` ```brainfuck ` 的文档会让渲染炸掉。界面上一律先过 `normalizeLanguage()`,
   认不出来的一律当纯文本 —— 但下拉里**照实多显示一个「brainfuck(未识别)」选项**,
   而不是装作是纯文本(后者会让人以为自己写的东西被系统改掉了)。

顺带修掉一件"看起来偶发"的老问题:**工具栏的激活态原来会滞后** ——
`isActive('bold')` / `isActive('table')` / `isActive('codeBlock')` 都是"此刻光标在哪"的
函数,而 `onUpdate` 只在**内容**变化时触发。于是"点进代码块看不到语言下拉、
光标移到加粗文字上 B 不亮",得再敲一个字才对。订阅 `onSelectionUpdate` 之后正常。

> 语法高亮只注册了 18 个语言(highlight.js 自带 190+,全量引入会让这个页面的包
> 大出几百 KB),按"研发场景真的会写"挑的。前台正文字号那一档也顺手对齐了刻度表
> (`0.85em` → `0.875em` = 14px)。
>
> 打包体积因此从 ~600KB 涨到 **871KB(压缩后 275KB)**。这是把编辑器能力补全的代价,
> 若要压回去,方向是**按需加载语法**(用到某个语言才 import 那一个语法文件),
> 已记进 §11.3。

### 7.5 字号与排版刻度(v2.8,有出处、有机器检查)

用户**三次**反馈「字体太小」,并在最后一次明确要求：
「你能不能找几个好点的网站去参考一下,就常规的博客网站也行,或者直接去看看 confluence 是如何做的」。

这句话点破了问题的性质：**前两次我都在拍脑袋调数值,没有参照任何真实产品的设计。**
这一次先查规范,再定刻度。

#### 参照一：Atlassian Design System(Confluence 用的就是它)

| Token | 字号 / 行高 | 官方说明 |
|---|---|---|
| `font.body.large` | **16 / 24** | 长文阅读的默认档(博客、文档) |
| `font.body` | **14 / 20** | **组件里的默认档**;「配合图标时用 Medium(500) 字重」 |
| `font.body.small` | **12 / 16** | 「**谨慎使用**,仅用于次级内容,如细字印刷」 |

Confluence 的更新日志里还有一句关键的话：视觉改版「把最小的标题与正文字号
**从 11px 提到 12px**」—— 也就是说 **11px 低于 Atlassian 自己的下限**。
Confluence 编辑器的正文是 **16px**,新加的「小号正文」是 14px。

#### 参照二：Ant Design(中文界面,更贴近本项目)

- 基础字号**从 12 提到 14**,理由是「基于 50cm 阅读距离与最佳阅读角度」。
- 推荐正文 14 / 行高 22;辅助文字 12 / 行高 20。
- **中文字体行高要在 1.5–1.8 之间** —— 汉字密实且字高一致,比西文更需要留白。
- 「字阶的选择尽量控制在 **3–5 种**之间,保持克制」。

#### 刻度(四档,与 Tailwind 具名档一一对应)

| 层 | 值 | 写法 | 依据 |
|---|---|---|---|
| 文档正文 | **16px / 1.7** | `.kc-prose`(`styles.css`) | ADS `body.large` 16/24;Confluence 编辑器正文也是 16px。行高取 1.7 而非 1.5,是照顾中文 |
| **内容**：组织树行、右栏目录项、评论正文、子页面列表 | **14px / 20px** | `text-sm` / `T_BODY` | ADS `font.body` —— **组件默认档** |
| **组件标签**：tab、按钮、字段标签、面包屑、元信息 | **14px / 20px** + `font-medium` | `text-sm font-medium` / `T_LABEL` | ADS：组件里用 14px,配合图标时用 Medium |
| **元信息**：计数、快捷键提示、时间戳、状态徽章 | **12px / 16px** | `text-xs` / `T_META` | ADS `body.small` —— 仅用于细字印刷 |

三档的数值与 ADS 的 `body.small` / `font.body` **完全一致** ——
因为 Tailwind 的 `text-xs`(12/16)与 `text-sm`(14/20)恰好就是这套值。

字体族也显式写出来了(`styles.css` 的 `body`)：系统字体优先,中文字体按平台覆盖
(PingFang SC / Microsoft YaHei / Noto Sans SC)。不写的话会出现"开发机上是雅黑、
服务器上变宋体"这类只在某台机器上难看的问题。

#### ⚠️ v2.7 的两个错误(这一节存在的意义)

| 错误 | 后果 | 纠正 |
|---|---|---|
| **最小字号定成 11px** | 比 Confluence 的下限还低 | 提到 **12px**。Atlassian 特意从 11 提到 12,理由是可读性 |
| **把 tab / 目录 / 评论当成"次级信息"塞进 12px** | 用户连续两次说"目录很小、评论很小" —— 它们本该是**组件级文字** | 提到 **14px**。ADS 明确说 12px 是"谨慎使用的细字印刷" |

判据不是"它重不重要",而是「**它是不是要被读 / 被点的界面文字**」。
真正的 12px 只剩：计数、快捷键提示、状态徽章这类一眼扫过的东西。

#### 唯一规则：不允许任何任意值字号

`lib/typography.test.ts` **扫描源码**,两条断言：

1. 没有任何字号小于 12px
2. **不允许出现任何任意值字号**(9 / 10 / 11 / 13px 这类)

第 2 条比 v2.7 更严：上一轮还留了一个 11px 的例外,而那一档已经被规范否掉了,
所以现在**一个例外都没有** —— 全部走 Tailwind 具名档(唯一的 16px 在 `styles.css`)。

> ⚠️ 扫描器**不区分注释** —— 所以写"原来 9px 太小了"这类说明时不能写出完整类名。
> 这是故意的：注释掉一行照样被查到,规则没有绕过的余地。
> (反过来做要先用正则认注释,而 `//` 出现在 URL 之类的字符串里就会误剥。)

#### 同一个问题里的**非字号**缺陷(v2.8)

改字号的过程中,真渲染验证又抓出四处**跟字号无关、但同样让人说"丑"**的问题：

| # | 问题 | 根因 |
|---|---|---|
| 1 | 页头元信息被挤成 **3 行**,且「更新于 2026/9/27」与「02:35:15」被**拆成两截** | 元信息嵌在标题的 `flex-1` 容器里,右侧那排按钮(约 220px)把它挤到只剩一百多 px。**这不是字号问题,是谁和谁抢同一行的问题** —— 挪到标题行外面、占满页头宽度,并给每项加 `whitespace-nowrap` |
| 2 | 页头 / 卡片 / 编辑器用了**三种横向内边距**(24 与 32px 混用) | 左边框对不齐。统一到 **32px** |
| 3 | 侧栏底部常驻**三段灰色说明文字** | 典型的"信息架构没做、用说明书补"。拖拽说明改成**只在拖拽时出现**(正好出现在需要它的那一刻);"悬停能看到什么"交给按钮的 `title` |
| 4 | 「组 / 部门」节点打开是**一块空白编辑器** | 而它下面其实挂着好几篇文档。Confluence 在空间首页列的是子页面 —— 补 `ChildPages`(数据直接取自已缓存的组织树,不新增接口) |
| 5 | 树只有缩进、没有**层级引导线** | 第三级以下要靠数像素去猜"属于哪个组"。补上细竖线(Confluence / Notion 的做法),位置与上一级展开箭头对齐 |

#### 一处差点误删

清理测试残留节点前,我先查了创建时间与父子关系,发现 `视觉项目组`(含一个三级页面)
**是用户自己建的** —— 他用来复现更早那个「第三级没缩进」的问题。
只有 `赵敏的临时笔记` 才是测试产物。
**清理前必须按时间 / 归属区分"用户建的"与"测试建的",不能按标题猜。**

#### 点击目标尺寸(v2.9):字号之外的另一条下限

用户最后一条反馈是「把这个展开符号搞大一点,不然鼠标点着太费劲了」。
它和字号问题同源,但**不是同一件事**:那处控件是**点击目标**,不是文字。

| | 改前 | 改后 |
|---|---|---|
| 字形 | Unicode 的 `▾` / `▸`,12px | **SVG 雪佛龙,16px** |
| 点击区 | 20×20 | **24×24**(树行高 36px,放得下) |
| 悬停反馈 | 只有字形变色 | 字形加深 **+ 24px 圆角底色** |

三点理由,都不是"看着大一点"这么含糊:

1. **24px 是公认的目标尺寸下限**(Apple HIG 与 WCAG 2.2 的 Target Size 都是 24px)。
   低于它的控件对鼠标就是不友好 —— 用户说的"费劲"是准确的。
2. **Unicode 三角不该用来做控件。** `▾`/`▸` 在大多数字体里**垂直居中偏移**
   (下缘比上缘空),所以它看着比字号更小,而且换个字体就换一个样子。
   换成 SVG 之后尺寸与居中都由自己控制,放大不糊,还能加旋转过渡(150ms)。
3. **只让字形变色,用户仍不知道该往哪儿瞄准。** 悬停给一层底色,
   把"这里可点、可点范围有这么大"直接画出来。

> ⚠️ 靠**加宽点击区**解决问题时,必须重新核对**同一行里其它元素的落点**。
> 这个箭头是行的第一个元素,它宽 4px 就意味着整列(徽章、标题、
> 以及层级引导线)全部右移 4px。这里的做法是把行的 `paddingLeft` 常数
> 从 `6` 减到 `4`,于是 `4 + 24/2 = 16` 与原先 `6 + 20/2 = 16` **完全相等** ——
> 引导线公式一个字没改,整列一个像素没动。改动越小,越容易证明没改坏。

#### 验证方式

除源码扫描外,还用无头 Chrome **在运行时**核对：遍历每个叶子文本节点,
断言计算字号 ≥ 12px。**5 个页面 + 3 个弹窗全部为 0**,
并读回关键位置的计算字号(树行 14 / tab 14 / 目录项 14 / 评论正文 14 / 正文 16 / 标题 24)
与"有没有被截断"。

> 窗口尺寸取**用户的实际窗口**(1084×872)。用 1440 宽渲染会让字"相对更小",
> 与他的观感对不上 —— 他说"太小"是在**他的窗口里**看到的。

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

**实现要点(v1.6 补)**

- 递归重建用**一条 UPDATE** 完成,不逐行改:
  `SET materialized_path = <新前缀> || substr(materialized_path, <旧前缀长度> + 1)`
  自身(整串 = 旧前缀)截出来是空串,恰好得到新路径;子孙则保留下半段相对路径。
- 防环用**路径前缀**判定(`目标路径.startsWith(自身路径 + '/')`),不递归查子孙 ——
  更便宜,而且不可能漏。**前缀末尾的斜杠不能省**,否则 `/p-1` 会被误判为 `/p-10` 的祖先。
- ⚠️ **必须写 `substr(x, $n::int)`,不能写 `substring(x from $n)`**:
  后者在参数类型为 `unknown` 时(驱动层就是这么发的)会被 PostgreSQL 解析成
  **POSIX 正则**那一支并**静默返回 NULL** —— 开工实测踩过。
  若 `materialized_path` 可空,这会把整棵子树的路径悄悄清空而不报任何错。
- 「数一数再写」的检查放在 **Serializable** 事务里(同 §6.1 的会话机制与 §5.5 的缓存策略):
  并发下两个移动可能互相踩。
- 软删除**只标记 `deleted_at IS NULL` 的行**:子树里可能已经有早先单独删掉的页面,
  再盖一次新时间戳既无意义,也会让返回的 `removedCount` 虚高。
- 彻底删除必须**从叶子往根删**(按 depth 逐层):`pages.parent_id` 是 `onDelete: Restrict`,
  而 `DELETE` 不支持 `ORDER BY` —— 外键检查是即时触发的,处理到父行时子行还在,直接撞约束。

### 8.2 软删除与恢复

```
DELETE /nodes/:id
  1. 递归收集整棵子树 id(用 materialized_path 前缀查)
  2. 整批设置 deleted_at / deleted_by(同一时间戳),**只标记尚未删除的行**
  3. 审计日志记录子树规模
POST /nodes/:id/restore
  1. 若原父节点仍在回收站里,则挂到顶层
  2. 整批清空 deleted_at / deleted_by
```

### 8.3 检索(v2.0:不再做权限过滤)

```
GET /search?q=知识
  1. SELECT n.id, n.title, c.text_for_search
       FROM node_contents c JOIN nodes n ON n.id = c.node_id
      WHERE n.deleted_at IS NULL
        AND (n.title ILIKE '%'||q||'%' OR c.text_for_search ILIKE '%'||q||'%')
      ORDER BY <命中位置权重> DESC, similarity(...) DESC, n.updated_at DESC
      LIMIT 20;
```

**v2.0 起不再需要权限过滤** —— 读是全员开放的(§5.3 规则一)。两个直接好处:

1. 查询里没有 `ANY(可见集合)` 子查询,中文检索的单次开销明显下降;
2. 不存在"树上看不到、但搜得到"这类泄露 —— 树上本来就没有隐藏项。

> ⚠️ **代价必须写进产品说明:全公司任何人搜任何关键词,都能搜到任何部门的文档。**
> 这是有意的产品选择,但它意味着**系统不提供保密能力**(见 §5.3 规则一)。
> 将来若冒出保密需求,**那不是"加一个开关"能解决的** —— 要重新设计权限模型。
> 到那时应当把这条决策翻出来重新审视,而不是在检索里临时打补丁。

**排序为什么不只用 `similarity()`(v1.7 补)**

trgm 的 `similarity()` 需要至少 3 个字符才有意义 —— 中文搜两个字(「权限」「部署」)
普遍得到 0,排序会退化成不确定顺序。所以主排序键是**命中位置**(标题命中权重 2、
正文命中权重 1),`similarity()` 只做同档内的次级排序,最后以 `updated_at` 兜底。
这样无论查询是两个字还是十个字,结果顺序都稳定且符合直觉。

另外:`LIKE` 的通配符必须转义。不转的话搜 `100%` 会命中全部内容(实测已覆盖)。

> v1.x 这里写的是「可见范围必须与页面树共用同一份计算」。**v2.0 起该要求作废** ——
> 已经没有"可见范围"这个概念了,树上与检索里都是全集。`PermissionService.visibility()` 一并删除。

### 8.4 页面级评论

```
POST /nodes/:id/comments  { body, parentId? }
  1. **不校验权限** —— 全员都能评论(§5.4)
  2. parentId 若非空,校验其属于同一节点,且不产生二层以上嵌套
  3. 写入
  4. 角标计数(节点树)由服务端一并算好
```

阶段一**不发任何通知**。用户怎么知道有新评论?靠节点树上的角标(`GET /comment-counts?ids=`)。
这是刻意的范围控制 —— 通知是阶段二的事。

#### ⚠️ 评论就是评论,不是"问题单"(v2.5 修正)

v2.0 那一版给评论加了一套 `open` / `resolved` 状态,界面上表现为「标记已解决」按钮、
「已解决」徽章,以及节点树上"未解决评论"的琥珀色角标。

用户明确纠正:

> 「评论只是评论,不是问题,你在页面中直接把评论列为问题,这个不对,
> **你不要擅自赋予评论额外的含义**。」

那套语义已**整体移除**,包括:

| 移除的东西 | 换成了什么 |
|---|---|
| `comments.status` 列(`open` / `resolved`) | **删列**(迁移 `drop_comment_status`) |
| 「标记已解决」/「重新打开」按钮 | 没有了 |
| 「已解决」徽章 | 没有了 |
| 树上的**未解决**评论角标(琥珀色) | **评论总数**角标(中性灰) |
| `CommentView.status` / `canResolve` | 换成 `canEdit`(只有作者本人) |
| `CommentListResponse.openCount` | 换成 `total` |
| `PATCH /comments/:id { status }` | 只剩 `{ body }` |

> **角标颜色也是这次一起改的。** 琥珀色等于暗示"有待处理的事" ——
> 而它数的只是"有几条评论"。颜色在中性灰上,含义才与事实一致。
>
> **不要再以"将来可能会用"为理由把状态字段加回来。** 一个没人要求的状态机,
> 会让每条评论都背上"它解决了没有"这个问题,而讨论本来不需要被结案。

**实现要点(v1.7 补;v2.0 / v2.5 修订)**

- **只允许一层回复**:`parentId` 指向的那条必须自己也是顶层评论,否则 400。
  无限嵌套在 UI 上极难表达,而知识库的讨论几乎不需要它。
- 跨节点的 `parentId` 一律拒绝。
  (v1.x 给的理由是"否则可以挂到你无权访问的页面上";新模型里读是全员开放的,这个理由不再成立,
  但仍要拒绝 —— 一串讨论必须落在同一个节点上,否则 UI 无处呈现。)
- **改与删是两件事,门槛不同**(v2.5 分开):
  - **改正文:只有作者本人** —— 该节点的所有者也不行,改别人的话是篡改他人言论
  - **删除:作者本人,或该节点的任一祖先所有者** —— 后者属于版务清理

  v2.0 时两个按钮共用 `canDelete` 一个标志,结果是**所有者能看到「编辑」按钮、点了却 403**。
  现在接口返回 `canEdit` 与 `canDelete` 两个字段,按钮与服务端判定才一致。

---

### 8.5 组织架构导入(Excel · v2.1 定稿)

管理员维护组织架构的**主入口**。日常只加人不减人,所以语义定为**增量**。

#### 三步流程

```
GET  /admin/org/import-template   → 下载 .xlsx(带当前全部人员与节点)
       在 Excel 里改
POST /admin/org/import?dryRun=1   → 上传,只返回差异预览,**不写库**
POST /admin/org/import            → 确认写入(一次事务)
```

⚠️ **第二步与第三步是同一个接口的两个模式,不是两个接口。** 服务端只有一份解析与差异计算逻辑,
`dryRun` 只是"算完不提交"。这样预览里看到的与真正写进去的必然一致 —— 若拆成两套代码,
两边迟早算出不同结果,而管理员是**照着预览做决定**的。

#### 增量语义的准确含义

| 表格里的情况 | 处理 |
|---|---|
| 工号在系统里**不存在** | **新建**(`status=active`,初始密码 `123456`,`must_change_password=true`) |
| 工号**已存在** | 不新建;按需要补上归属 |
| 工号已存在但**姓名不同** | **以表格为准更新姓名**(改名 / 上次填错都是常事) |
| 归属已存在 | 跳过(**幂等**) |
| 归属不存在 | **新增一条归属** |
| 表格里**没出现**的人 | **完全不动** —— 不删、不停用、不改他的归属 |

> **因此:同一份表格上传第二遍、第三遍都不会重复建号,可以放心反复上传。**
> 这是"增量"最有价值的一条保证。

#### ⚠️ 已知限制(必须在界面上有对应操作)

**"把人从某个组移出去"做不到。** 增量语义下,"表格里没写"与"要删掉这条归属"**无法区分** ——
既然不删人,也就不删归属。所以**调岗**需要两步:

1. 导入新归属(表格里加上「张三 / 前端组」),或在节点的成员弹窗里直接「加入」
2. 在界面上把旧的「张三 / 后端组」移出

**第二步的入口已在 v2.4 补齐**:节点成员弹窗(`☰`,见 §7.2)列出该节点下的所有人,
可加入 / 移出。它刻意与权限弹窗分开 —— 归属是组织事实,权限是判定结果。

移出归属**不会**改变所有权(被移出的组长仍然是组长),但**会缩小他的组织范围**。
这两个后果写在确认框里,并有单测钉住。

> 为什么"两步"是设计而不是缺陷:一步式(导入即全量覆盖)意味着**一次误操作就能把全公司的
> 组织关系抹掉**,而导入又是管理员会反复做的事。增量 + 显式移出把不可逆的那一步
> 留给了一个必须逐个确认的动作。

同理,**离职走界面,不走表格**:把该用户的 `status` 改为 `departed`(见 §4.2),
而不是从表格里删掉他那一行。用户明确要求:**"人员删除以后,把这个人员标记为离职,
在他自己创建的页面上也标记为离职"** —— 前端在作者名旁显示「已离职」,历史记录不抹掉。

#### 模板列设计

| 工号 | 姓名 | 部门 | 组 / 项目 | 负责人 | 部门ID(勿改) | 组ID(勿改) |
|---|---|---|---|---|---|---|
| KC2026001 | 王建国 | 技术部 | | 是 | 7f3a… | |
| KC2026002 | 李峰 | 技术部 | 后端组 | 是 | 7f3a… | 9c21… |
| KC2026003 | 陈默 | 技术部 | 后端组 | | 7f3a… | 9c21… |
| KC2026003 | 陈默 | 技术部 | CRM 项目 | | 7f3a… | 4b88… |
| KC2026010 | 赵敏 | 设计部 | | 是 | 1d05… | |

**一行 = 一个人在一个节点上的归属。** 陈默出现两行不是重复,是"他同属后端组与 CRM 项目"。

- **`工号` 是人的唯一标识**,也是判断"这一行说的是谁"的依据 —— 不是姓名(会重名),也不是邮箱
- `工号` / `姓名` / `部门` 必填;`组 / 项目` 留空 = 只属于部门
- `负责人` 填「是」:指**这一行最深的那个节点**的负责人(填了组/项目即组长,没填即部长)
- **`部门ID` / `组ID` 两列只读、勿改**,是**匹配节点的第一依据**(理由见下)
- **模板里没有密码列** —— 新账号统一用内置初始密码,首次登录强制改密(见 §6.1.2)

#### ⚠️ 为什么必须有 ID 列:部门会改名

用户明确说明"**部门不会消失,只会更名**"。若只用**名称**匹配节点,会撞上一个很难发现的坑:

> 管理员把「技术部」改名为「技术中心」,然后照常下载模板、上传 —— 服务端按名字找不到「技术中心」,
> 于是**自动创建一个新的「技术中心」**,而旧的「技术部」(连同其下全部文档)还在。
> 结果:**同一个部门在系统里出现两份**,新那份还是空的。

所以匹配规则是**两段式**:

1. **先看 ID 列**:非空且系统里存在 → 就是它。此时名称变化视为**更名**,直接更新标题
2. **ID 为空**(新行)→ 再按**名称**匹配(部门在 depth 0、组在其部门下);仍匹配不上才**自动创建**

**为什么是两列而不是一列**(v2.3 实现时的修正):一列只能标识"这一行最深的那个节点"。
当**组是新建的、而部门刚改过名**时,那一列是空的,名称又对不上 → 还是会重复建部门。
拆成两列之后,部门这一层始终有 ID 兜底。

#### 自动创建与负责人规则

- 表格里出现、系统里没有的部门 / 组 → **自动创建**(免掉"先建组织再导人"两步)
- **新建的部门必须恰好有一个「负责人 = 是」**,否则**拒绝导入并报错**。
  这条同时防住一类事故:**部长离职后若把他的行删掉,技术部就没人能管了** —— 导入会直接拦下来
- ⚠️ **现有部门没写负责人 → 保持原所有者不变**,不报错。
  这条是实现时补的,而且是**必须**的:部长常常并不是本部门的归属成员,
  模板里就没有他那一行 —— 若把"没写"当成"要清空",会出现
  「下载模板 → 原样上传」就报一堆错的情况。增量语义的意思是"没写就不动"。
- ⚠️ **不做任何"兜底继承"**。曾想给"没写负责人的组"继承部门负责人,但那会破坏一条重要的性质:
  **下载模板后原样上传应当是零差异**。兜底一旦存在,每次导入都会把没写负责人的组建模成"改成部长",
  而管理员根本没表达过这个意思。(这条性质在 §9.3 有专门的验收用例。)
- 两个负责人(同一节点)> 任何解释都不对(谁说了算没定)→ 直接拦下来

#### 实现要点

- 解析用 **`exceljs`**。不选 `xlsx`(SheetJS):社区版的已知安全问题较多,而这是**上传文件解析**场景,
  正好是它的攻击面。
- 导入要处理**顺序依赖**:某行的负责人可能是同一表格后面几行的人。
  实现上是**先建人、再建节点、最后建归属**(节点分 depth 0 / depth 1 两批插,
  因为 `parent_id` 是自引用外键而 PostgreSQL 逐行即时检查)。
- 差异预览分六类并给计数与明细:**新增人员 / 人员改名 / 新增归属 / 新建节点 / 节点改名 / 换所有者**,
  外加「跳过的行」及其原因。
- 整个写入放在**一个事务**里,并在事务外先把 bcrypt 哈希算好(全员共用初始密码,只算一次)
  —— 放进事务里会让几百毫秒的 CPU 计算占着一条数据库连接。**任何校验失败 → 整批不写**,
  不允许"导了一半"。
- **解析与写库共用同一份纯逻辑**(`org/import.core.ts`):预览与确认写入走同一份代码,
  否则两边迟早算出不同结果,而管理员是照着预览做决定的。
  这个文件是"错了会静默越权"的高危逻辑,单测覆盖了幂等性、改名识别、组织边界等 20 余条
  (§9.3 有实测口径)。
- ⚠️ **权限检查必须在文件校验之前**。反过来的话,普通成员不带文件请求会先撞上
  "请选择文件"的 400 —— 等于确认了"这个接口存在"。权限不足就该一律 403。
  (这条是实跑验收时发现顺序错了才补的。)
- 审计:导入记一条 `org.import`,detail 带差异摘要(新增 N / 变更 M)。
  **一次导入写一条**,不逐行写 —— 几百行会把这个表刷爆。

---

## 9. 阶段一里程碑任务拆解

以下按**单人全时**估算,共约 **22 个工作日**,预留缓冲后 **4~5 周**。

> ⚠️ **这份 M1~M6 清单是 v1.x 时代的执行记录,不是待办。**
> 被 v2.0 作废的部分在各阶段开头有单独的 ⚠️ 标注(如 M2 的"空间与成员");
> 未标注的条目里也有**表名已改**的(如 `page_contents` → `node_contents`)——
> 那些描述的是"当时建了什么",不是"现在叫什么"。
> **v2.0 及之后的任务清单看 §9.2**,接口与模型的当前状态看 §6 / §4。

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

> ⚠️ **v2.0 起本阶段的「空间与成员」部分整体作废** —— 空间不再由用户创建、成员角色制被取消。
> 认证部分(不透明会话 / 守卫 / `/auth/setup`)保留。重做清单见 §9.2。

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

- [x] pages 表、物化路径与 depth 维护逻辑
- [x] 页面树 CRUD + `move`(含递归重建路径)+ 防环校验
- [x] 软删除 / 回收站 / 恢复(子树级联;原父不在树上时挂回根)
- [x] 前端页面树组件:展开折叠、新建、重命名、删除、**拖拽排序(三区命中)**
- **验收**:把一棵三层子树拖到另一个分支下,查库确认所有子孙的路径都已更新
  —— **已达成(2026-09-26)**。实测刻意分两段:
  ① **接口层 55 项断言全通过**,且覆盖失败路径:防环 400、乐观锁 409、
     只读成员建/删/移/彻底删全部 403、畸形 id 400、彻底删除必须先软删除 400。
  ② **直接查库 11 项断言全通过** —— 把 `X ─ Y ─ {Y1,Y2}` 里的 Y 移到另一个根 W 下之后,
     库里 `Y / Y1 / Y2` 三行的 `materialized_path` 与 `depth` 全部重建,
     而未移动的 X 与 Z 一个字都没变。这正是「只改自己那条路径」写错时会失败的地方。
  单测:api 139 / shared 60 / web 27。
  前端四个页面(空间概览、页面树、页面详情、回收站)已用无头浏览器实渲染确认。
- **本阶段的一处实测坑**(已写进 §8.1):`substring(x from $n)` 在参数类型 unknown 时
  会走 PostgreSQL 的 POSIX 正则分支并**静默返回 NULL**,导致整棵子树的路径被清空而不报错。

### M4 · 正文与检索(6 天)

- [x] page_contents 表 + ProseMirror JSON 存取(带 `baseUpdatedAt` 乐观锁)
- [x] `content_json` → `text_for_search` 的纯文本抽取器
- [x] Tiptap 编辑器:工具栏、图片上传(本地卷)、表格、代码块
- [x] `pg_trgm` 索引 + `/search` 接口(含权限过滤)
- [x] 前端编辑器页 + `Cmd/Ctrl + K` 命令面板 + `/search` 结果页
- **验收**:中文关键词能搜到正文里的内容,且搜不到无权限页面的内容
  —— **已达成(2026-09-26)**。覆盖率见下方的「M4+M5 端到端验收」。

### M5 · 权限与评论(5 天)

> ⚠️ **v2.0 起本阶段的「权限判定」部分整体作废** —— 五档角色、能力矩阵、deny、最小可见全部取消。
> **评论部分保留**,并放开为全员可发。重做清单见 §9.2。

- [x] page_permissions 表 + `effectiveRole` 判定实现
- [x] Redis 缓存 + 变更时整片失效(实现为**空间级世代号**,理由见 §5.5)
- [x] 全接口接上权限守卫,**逐条写测试**
- [x] comments 表 + 4 个接口(+ 未解决计数)
- [x] 前端:权限设置弹窗(推导链 + 规则增删)、评论面板
- [x] 审计日志写入与查询页
- **验收**:权限矩阵里每一格都有对应的通过 / 拒绝测试 —— **已达成(2026-09-26)**。

### M6 · 收尾(3 天)

- [x] 页面导出为 **Markdown**(PDF 需要额外依赖,不在阶段一范围内 —— 见 §11.3)
- [x] 备份脚本:`pg_dump` + 附件目录打包,**含恢复演练脚本**
  (`scripts/backup.sh` / `restore-drill.sh` / `restore.sh`)
- [x] 部署文档(`DEPLOY.md`)+ `.env.example` + 初始化说明
- [x] 全量冒烟测试 / 走查
- **验收**:在干净机器上照部署文档从零跑通一遍 —— 见 §9.1

### 9.1 M4+M5 端到端验收(2026-09-26 实测 · **历史记录**)

> ⚠️ 这一节记录的是 **v1.x 模型**下的验收。v2.0 改造后,验收脚本已换为
> `pnpm verify:org`(85 项断言,见 §9.2),本节保留作为"那一版做过什么"的存档 ——
> 但**其中的断言口径不要照搬**,有一批在新模型下是反的(如"只读成员越权 403")。

`docker compose down -v` 清空数据卷 → `up -d --build` → `pnpm seed:dev` → `pnpm verify:m4m5`(已删除)。
当时的验收脚本是 `apps/api/scripts/verify-m4m5.mjs`,**v2.0 改造时连同断言一起删掉了** ——
所以下面这些数字**现在无法复现**,只能当作"那一版做过什么"的存档看。
(原文写的是"脚本在仓库里…可以自己复现",那是 v1.x 的说法;表名与语义都换过一轮之后
它既不成立、也会误导人。**留一份不能复现的数字是可以的,但必须写明它不能复现。**)
**当时 76 项断言全部通过,0 失败**(连跑两遍结果一致 —— 脚本会自己还原改动,可重复运行),分为八组:

| 组 | 覆盖 | 其中值得单列出来的 |
|---|---|---|
| A 正文 | 取/存/往返/冲突/上限 | 过期 `baseUpdatedAt` → **409**;非法结构 → 400;超 2MB → 400 |
| B 中文检索 | 字词命中 / 标题命中标记 / 通配符 | 搜「%」**不命中全部**;超长关键词 → 400 |
| C 页面级权限 | 树过滤 / 越权 / 检索过滤 | **deny 从树里消失**;**子页面的 allow 翻不了父页面的 deny**;**检索结果按权限过滤** |
| D 规则与推导链 | 读写 / 校验 / 候选主体 | 同主体两条规则 → 400;页面级不接受 admin 角色 |
| E 评论 | 增删改 / 嵌套限制 / 越权 | 回复的回复 → 400;跨页面 `parentId` → 400 |
| F 审计 | 动作覆盖 / 越权 | 登录、建页、存正文、评论、权限变更均有记录;只读成员查审计 → 403 |
| G 导出 | 内容 / 头 / 权限 | 表格导出为 GFM;导出被 deny 的页面 → 404 |
| H 附件 | 上传 / 直出 / 白名单 | Nginx 直出带 `nosniff`;**svg → 400**;**`shell.png.exe` → 400** |

单测:api 211 / shared 61 / web 27 = **299 项**;`pnpm typecheck && pnpm lint` 全绿。
前端 8 个页面(登录、编辑器、评论、权限弹窗、检索、审计、回收站、只读视角)已用
**无头浏览器 + CDP 注入会话 Cookie**实渲染确认,页面内无 JS 报错。

**验收过程中发现并修掉的五个真问题**(都不是"只读代码"能发现的):

1. **Express 请求体默认 100kb** —— 而正文上限是 2MB。长文档保存会被 body-parser 拒掉,
   而且错误是 500。已抬高到 8MB,并把解析错误映射成 `VALIDATION_FAILED`。
2. **`express` 是传递依赖** —— 直接 `import { json } from 'express'` 在本地能跑,
   进镜像就 `ERR_MODULE_NOT_FOUND`。改用 Nest 的 `useBodyParser()`。
3. **`jsonb` 不保留键顺序** —— 让"往返一致性"断言一开始误判成失败。已改为按语义比较,
   并把结论写进 §4.3。
4. **恢复演练用 `n_live_tup` 比行数 → 假失败** —— 那是 autovacuum 维护的**统计估算值**,
   在一个刚恢复出来的库上与生产库根本不可比。第一次在服务器上演练时报
   「audit_logs 生产=71 恢复后=61」,而备份完全正常(真实行数两边都是 61)。
   **假失败比没有演练更糟**:要么让人对好备份失去信任,要么让人对真问题麻木。
   已改成逐表 `count(*)`。5. **权限弹窗的 flex 布局** —— `w-full` 的 `select` 在 flex 行里抢满空间,
   把规则标签压成竖排、按钮挤成两行。另外 `Button` 会**忽略**传入的 `className`
   (JSX 里后写的同名属性胜出),已改成合并。这两处只有实渲染才看得出来。

**服务器实跑额外验证的两件事**:

- `scripts/backup.sh` 在部署实例上跑通(10 张表 + 附件包 + 对账清单)。
- `scripts/restore-drill.sh` 跑通:备份导入临时库后 **10 张表逐表精确一致**,
  附件包可解,全程不动生产库。

---

### 9.2 v2.0 改造任务清单(2026-09-26 追加)

模型从"自由空间 + 角色等级"改为"组织架构 + 所有者/祖先链"后,以下工作**必须重做**。
分四个批次,**约 15 个工作日**(不含重新验收)。

#### 影响面速查

| 原成果 | 处置 |
|---|---|
| M1 基础设施 | **完全保留**(compose / Prisma / 健康检查 / 异常过滤器) |
| M2 身份与空间 | 认证部分**保留**(会话 / 守卫 / setup);**空间与成员整块重做** |
| M3 页面树 | **核心保留**,改名 `pages` → `nodes`,加 `kind` 与 `owner_id` |
| M4 正文与检索 | **完全保留**,只需把 `/pages/:id/content` 改成 `/nodes/:id/content` |
| M5 权限与评论 | 评论**保留**(放开为全员可发);**权限判定整体重写** |
| M6 收尾 | 备份 / 恢复脚本**保留**;部署文档需同步组织架构初始化步骤 |

#### 批次一 · 数据模型迁移(3 天)—— ✅ 已完成(2026-09-26)

- [x] 新 schema:去掉 `spaces` / `space_members` / `page_permissions`;`pages` → `nodes`(加 `kind` / `owner_id`);`page_contents` → `node_contents`
- [x] 新增 `org_assignments`(组织归属)与 `node_grants`(授权名单)
- [x] 删除 `users.department` 列(单值部门无法表达多归属)
- [x] 三个索引(含部分索引与 GIN 三元组)重新声明,确保 `migrate dev` 不生成 `DROP INDEX`
- **不写数据迁移脚本** —— 现有数据是演示数据,清库重建比迁移便宜(见 §11.3)
- 实现补充:`users.employee_no` 取代 `email`(§6.1.2);`users.must_change_password` 新增;
  `nodes` 的树查询响应补 `version` 与 `status`(拖拽要用 `version` 做乐观锁,
  让前端"拖之前先拉一次详情"会读到过期版本然后**静默落到错误位置**)。

#### 批次二 · 权限服务重写(4 天)—— ✅ 已完成

- [x] `packages/shared/src/permission.ts` 重写为 `canRead` / `canEdit` / `canManage` / `canCreateUnder` 四个**纯函数**
- [x] 删除 `CAPABILITY_MIN_ROLE` 能力矩阵与五档角色枚举
- [x] 删除 `resolveRoleAlongChain` 与全部 deny 相关分支
- [x] `PermissionService` 改为:取祖先链(一条 SQL)→ 判定 → 缓存(按部门分片的世代号)
- [x] 实现 `orgScope(user)`(`isInOperatorScope`)—— 授权范围判定的核心
- [x] **额外补了 `canGrantTo`**:光有 `canManage` 不够,还要"被授权者落在我的组织范围内"(§5.3 规则三)
- [x] 单测重写:覆盖 §5.4 能力对照表每一行,重点是**组织范围越界必须被拒**

#### 批次三 · 组织架构管理(5 天)—— ✅ 已完成

- [x] 超管接口:建部门 / 建人 / 改状态 / 设归属 / 任命所有者
- [x] **新账号统一初始密码 `123456` + 首登强制改密**(`must_change_password` 字段,见 §6.1.2)。
  **⚠️ v2.5 重做了这一块**:首登改为**不建立会话**(只给一张一次性凭证),整套"改密白名单"机制删除
- [x] **Excel 导入(见 §8.5)**:模板下载(`exceljs` 生成)、上传预览(`dryRun`)、确认写入
- [x] 前端 `/admin/org` 与 `/admin/users`
- [x] 审计:所有者变更、授权增删、归属变更、**导入动作**都要留痕
- [x] ⚠️ **节点成员管理入口**(列出该节点下的人,可移出)—— 调岗与离职的必备配套,理由见 §8.5「已知限制」。
  **v2.4 补齐**:`GET/POST /nodes/:id/members` 与 `DELETE /nodes/:id/members/:userId`,
  前端是组织树上的 `☰` 与文档页的「成员」按钮。读全员开放、写要 `canManage`(超管另有放行),
  加入时受组织范围约束。审计动作 `org.member.add` / `org.member.remove`。

#### 批次四 · 前端导航重构(3 天)—— ✅ 已完成

- [x] 登录后直达工作台(`/`);删除 `/spaces` 空间列表页与 `/s/:spaceId/members` 成员页
- [x] 左侧树改为**完整组织树**(全员可见全部);路由 `/s/:spaceId/p/:pageId` → `/n/:nodeId`
- [x] 权限弹窗改为节点级:展示「所有者 / 上级所有者 / 额外授权」三段
- [x] 候选人选择器**调后端已过滤的接口**,前端不自己算组织范围
- [x] 权限开关按服务端返回的 `editableNodeIds` / `manageableNodeIds` 重算
      (前端只用来隐藏按钮,服务端仍是唯一裁判)

#### 验收口径(v2.0)—— ✅ 全部达成

1. ✅ 超管导入组织架构 → 部长登录 → 能在自己部门下建组、任命组长
2. ✅ 组员在自己组下建页面 → **他自己的上级链(组长 / 部长)都能改**,同组其他人不能改
3. ✅ 组长给该页面**加一个人** → 那个人能改;组长**删掉** → 那个人不能改
4. ✅ 组长**不能**把权限授予别的部门的人(组织范围约束生效)
5. ✅ 任意员工能**读到**任何部门的页面(全员开放)
6. ✅ 端到端脚本按上述 5 条扩写;失败路径的形状要对:越界授权 403、非所有者任命所有者 403

实际验收脚本是 **`pnpm verify:org`**(`apps/api/scripts/verify-org.mjs`),
**85 项断言全部通过**。它按 A~K 十一组组织,与旧脚本的区别写在文件头:
旧脚本里那批"建立在旧模型上"的断言被整体替换掉了,而不是被改绿。

> ⚠️ `pnpm verify:m4m5` 已**删除**。它的断言里有相当一部分建立在旧模型上
> (如"只读成员越权 403""检索结果按权限过滤")—— 这些断言在新模型下**本身就是错的**:
> 读是全员开放的,不存在"越权读"。**不要为了让它变绿而把新模型改回旧语义**,那是本末倒置。

### 9.3 v2.0 改造中实跑发现的问题(2026-09-26)

这一轮**有六个问题只有真跑起来才会暴露**。它们全都属于"读代码看不出来"的那一类,
记在这里是为了下次不再犯:

| # | 问题 | 症状 | 根因与修法 |
|---|---|---|---|
| 1 | **恢复与彻底删除实际上永远用不了** | 回收站打不开(404),恢复/彻底删除全部 404 | `PermissionService` 把"已删节点"当不存在,而回收站的三个操作恰恰要判定已删节点。`chainOf` 早就支持 `allowDeleted`,但 `requireEdit` / `requireManage` 没把它传下去 —— **只给取链传是不够的,判定本身也会拦** |
| 2 | **`GET /auth/me` 不在强制改密的白名单里** | 未改密的用户看到「无法连接到服务」,卡在原地进不了改密页 | 前端要靠 `me` 读出 `mustChangePassword` 才知道该跳哪一页。白名单从两条补成三条。**⚠️ v2.5 起整套白名单机制已删除**(首登不再建立会话,不存在"已登录但未改密"的状态)—— 这类"漏一条就卡住"的 bug 从此不可能再发生 |
| 3 | **导入接口的权限检查排在文件校验之后** | 普通成员请求时得到 400「请选择文件」,等于确认了"这个接口存在" | 权限不足就该一律 403,且要在任何其他判断之前。检查顺序挪到最前 |
| 4 | **超管在界面上没有「换部长」的入口** | 只有超管能改一级部门所有者,但他对一级部门不显示齿轮按钮 | 他不在 `manageableNodeIds` 里(他不是内容所有者)。树面板与权限弹窗都对"超管 + 一级节点"单独放行,并在弹窗里说明"组织权限与内容权限是分开的" |
| 5 | **模板里一个 ID 列不够** | 「组是新建的 + 部门刚改名」时仍会重复建部门 | 一列只能标识"最深那个节点"。拆成 `部门ID(勿改)` + `组ID(勿改)` 两列(§8.5) |
| 6 | **组织架构页把文档标成了「组长」** | 界面显示「研发规范 · 组长 陈默」 | 空间与页面在同一棵树上(§4.1),子节点必须**按 `kind` 区分**展示 |

另外两条**设计取舍**也在实现中被验证是对的,值得记下来:

- **"下载模板 → 原样上传 = 零差异"这条性质必须成立。** 它逼出了两个正确决定:
  现有部门没写负责人时**保持原所有者不动**(而不是报错或清空),以及**不做任何"兜底继承"**。
  这两条都写进了单测(§8.5)。
- **`allowDeleted` 这类开关必须在 service 的参数上显式存在**,而不是靠调用方"自己知道这是已删节点"。
  隐式约定在权限代码里必然出事 —— 出事时是 404 或静默越权,都不是显式报错。

### 9.4 v2.4 的两处刻意取舍

这两处都是"本来可以更省事,但省下来的那点事会变成日后的困惑",所以记下来。

**一、成员与授权不合并,哪怕它们看起来都在回答"这个节点上都有谁"。**

它们共享一个入口位置(树上的齿轮旁边)、共享一套候选人过滤逻辑,合并成一条接口
和一个带 Tab 的弹窗能省一半代码。但没有合并:

| | 成员 | 授权 |
|---|---|---|
| 回答的问题 | 他在**组织里的位置** | 他**能不能改**这个节点 |
| 数据 | `org_assignments` | `node_grants` |
| 写门槛 | `canManage` **或超管** | `canManage`(超管不在其列) |
| 移出的后果 | 他的组织范围变小(可能影响他能授权给谁) | 他不能改了 |

写门槛不同这一条尤其致命:合并后必然要取**更宽的那个**(否则超管改不了成员),
于是超管会看到一个"能编辑的授权名单"——而他在服务端根本没有那个权限。
**一条接口的权限语义必须单一**,否则它迟早会把两种权限混成一个更大的洞。

**二、`purgeSubtree` 抽出来给两条路径共用。**

手工「彻底删除」与回收站到期清理,除了"谁有资格触发"之外**完全一样**。
很容易顺手在 `RetentionService` 里再写一遍删除循环 —— 但那段循环里有一条
不显眼却重要的约束:必须按深度从叶子往根删(`nodes.parent_id` 是 `onDelete: Restrict`),
而 `DELETE` 不支持 `ORDER BY`。抄一份的代价是,某天有人只修了其中一份,
另一份就开始"偶尔删不掉",且不报错。

**凡是"删数据"的逻辑,只允许存在一份。**

### 9.5 v2.5 实跑发现的三个问题(2026-09-27)

这一轮是**用户实测反馈**驱动的(四条反馈 → 三处真问题),记下来是因为它们
都属于"读代码看不出来"的那一类。

| # | 问题 | 症状 | 根因与修法 |
|---|---|---|---|
| 1 | **树缩进在第三级之后就不再递进** | 「第三级组下面的页面」与它的父节点同一缩进,看不出谁属于谁 | 缩进算的是 `(node.depth > 2 ? 2 : node.depth) * 12 + 4` —— **depth 超过 2 被钳成 2**。当时大概是想防止深层节点把整行推出可视区,但它把"递进"这件事本身毁掉了。改成 `Math.min(depth, 8) * 13 + 6`:封顶提到 8 级,正常组织深度下永远够用 |
| 2 | **首次改密成功后,"密码已设置成功"的提示丢了** | 用户被送回登录页,但完全不知道刚才那步成没成 | 改密页有**两条**跳转路径:显式 `navigate(...)` 与兜底 `<Navigate to="/login">`。`clearSetup()` 一执行,`isFirstTime` 立刻变 false,兜底那条抢先触发 —— 而**它不带 state**。修法:不自己 navigate,改为先置一个本地 `changed` 标记,让**唯一**那条跳转路径带上提示。**同一件事有两条跳转路径时,只有一条会带上下文** —— 这类 bug 一定会发生 |
| 3 | **服务器上验收失败 2 项,本地全过** | `审计里有 org.import` / `node.content.update` 失败 | 审计接口只返回**最近 200 条**,而这两个动作只有"种子"或日常使用才会产生 —— 库里跑过几轮之后,最早那批被挤出去了。**依赖"历史记录还在"的断言迟早会坏掉**。修法:让验收脚本**自己制造**这两个动作(存一次正文 + 下载模板原样上传)。顺带把「模板原样上传 = 零差异」这条性质在端到端层面也验了(此前只有单测) |

> 第 3 条还有一层:**"本地过、服务器不过"本身就是信号**。
> 第一反应容易是"服务器环境有问题",但多数时候是**本地库更年轻**
> (记录更少、数据更干净),于是掩盖了断言的脆弱性。

> 另外两条是**断言本身写错**,不是功能问题:`预览成功` 断的是 `status === 200`,
> 而 Nest 的 POST 默认回 **201**。写死状态码在任何一次框架默认值变化时都会假失败 ——
> 除非你确实在验那个具体的码。

### 9.6 v2.6 实跑发现的两个问题(2026-09-27)

这一轮由用户一句话触发 —— **「测试账号没了?」**。账号当然还在,但这个问题
指出的是一类更值得记下来的东西。

| # | 问题 | 症状 | 根因与修法 |
|---|---|---|---|
| 1 | **系统里根本没有「重置密码」** | 同事忘了密码,唯一的办法是运维登进容器连上数据库手工改哈希 | 这不是 bug 而是**能力缺口**,而且是 §6.1.2「统一初始密码 + 首登强制改密」这套机制的必然配套 —— 有初始密码就一定会有人忘了改。补 `POST /admin/users/:id/reset-password`(§6.1.4)。**它的存在本身也解释了 #2**:正因为它此前不存在,开发者(我)才只能靠脚本改密码 |
| 2 | **验收脚本跑过之后,演示账号的密码就废了** | 「测试账号没了?」—— 文档里写 `123456`,实际是 `Kc-verify-2026` | `verify-org.mjs` 为验首次改密**必须真改** KC003 的密码,`login()` 辅助函数还会顺手改 KC004,而**没有任何地方还原**。后果有两条:①文档里的密码失效(用户直接撞上);②下一轮 A 组走"跳过"分支,总项数 **160 → 148**,看着像回归,其实是上一轮脚本自己造成的 —— **一个会污染自己前置状态的测试,比没有测试更坏**,因为它把"测试失败"和"环境被自己改坏"混成了同一个信号。修法:N 组用 #1 新加的接口把 KC003 / KC004 放回去,验收从此幂等(实测连跑三次:148 → 160 → 160) |
| 3 | **`GET /admin/users` 此前没有任何判权** | 任何登录用户都能拿到全公司名册 —— 而文档 §6.2 一直写的是超管 | 加 `mustChangePassword` 字段时才暴露:那个字段等于一份**"谁的密码还是 123456"的目标清单**。这是"文档写了、代码没做"的典型漂移,平时看不出来,直到新字段把它的后果放大。已按文档收紧为超管专属;「这个部门里有谁」仍走 `GET /nodes/:id/members`(读全员开放)—— 公开的是**组织归属**,不是账号状态与登录时间 |

> **这一轮的教训不是"忘了还原密码",而是:测试对系统状态的修改,必须由测试自己负责收回。**
> 否则每次运行都会让环境偏离一次,直到某一天问题以"功能坏了"的样子暴露出来 ——
> 而那时已经没人记得是第几次运行造成的了。

### 9.7 v2.7 实跑发现的两个问题(2026-09-27)

用户第二次反馈「字体太小了」,并在截图上圈了三个区域。这一轮的发现值得单独记:

| # | 问题 | 症状 | 根因与修法 |
|---|---|---|---|
| 1 | **"改了但没改好" —— 因为改的是症状不是机制** | 第一次按处调完,用户仍然觉得小 | 上一轮我统一了**工具栏内**和**树行内**的控件尺寸,却没有定义**"这一处该是几号字"的判断依据**。全项目当时有 9/10/11/12/13/14 六个档,每一处单看都"有理由",合起来就是"整体不对劲"。修法:定四档刻度(§7.5)+ **源码扫描测试**,规则由机器执行 |
| 2 | **放大字号之后,原本刚好放得下的标题被截断了** | 树的「CRM 项目概览」变成「CRM 项…」 | 树行那 6 个悬停按钮是 `flex-none` **常驻在流里**的,吃掉 130~160px;字号 13 → 14 之后剩下的 57px 就不够了。**这类副作用只有真渲染才看得见** —— 改字号时肉眼看的是"字清楚了",不会注意到右边少了一截。修法:改成绝对定位的悬停覆盖层,实测 8 个标题零截断、悬停前后标题宽度不变(245 → 245) |

> **第 1 条是这一轮真正的教训。**
> 用户说"字体太小",正确的问题是「**这里的字应该是几号?依据是什么?**」,
> 而不是「这一处调到多少才好看?」。前者会产出一个刻度表和一条检查规则,
> 后者只会产出一堆新的、各有各理由的数字 —— 而**下一轮还会有第三次反馈**。
>
> 定刻度时我差点又犯同一个错:起草了五档,给"次级信息"单独加了 13px,
> 写完才发现代码里已经有 64 处 12px。**多一档就多一次分歧的机会** ——
> 于是退回四档。这一条也写进 `lib/typography.ts` 了。

> 第 2 条还有一层:**任何"把东西变大"的改动都要重新检查"放得下吗"**。
> 字号、内边距、图标尺寸都是这样 —— 布局里每一处"刚好"都是被换算过的余量,
> 动了一边就必须看另一边。

#### 顺带修掉验收脚本自身的两个缺陷(v2.7)

部署时在服务器上跑验收,160 项里有 3 项失败。查下去发现**都不是产品的问题**,
是脚本自己的:

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 「组长改不动内容了」等 3 项失败 | v2.6 只让脚本还原了**密码**,没还原**节点与所有者**。一次崩溃的运行把「后端组」的所有者改成了赵敏且没还原,库里还积了 3 个测试节点 —— 于是**下一轮从 C 组开始就失败**,而且看起来像功能坏了 | `restoreToolState()` 扩成三件事:**密码 + 残留节点 + 被改的所有者**;正常路径在 N 组调,异常时在 `finally` 兜底;**开头还会自检**,发现上一轮残留就先自动清掉再跑 |
| 2 | 脚本中途抛异常,连汇总都打不出来 | I 组那句 `ownTrash.body.some(...)`:`underOwnGroup.body.id` 在上一步失败时是 `undefined`,请求打到 `/nodes/undefined`,返回的不是数组,`.some` 直接把脚本打断 —— **于是收尾还原也跑不到**,库越跑越脏,恶性循环 | 抽出 `arr()` 兜底 + 用 `?.` 取 id;`main()` 包在 `try/finally` 里 |
| 3 | 「赵敏看不到别人节点上的授权变更」失败,而**系统行为完全正确** | 断言只检查"她的日志里有没有 `grant.replace`"。可是审计的可见性规则是「**我是操作者** 或 目标节点在我的管辖范围内」—— **她自己**合法做过的授权变更本来就该出现。它能通过,只是因为干净的库里恰好没有这个反例 | 改成按操作者过滤:"看不到**别人的**授权变更"。这与 §9.5 第 3 条是同一类毛病 —— **别让断言的正确性依赖"历史里恰好没有某条记录"**,只是这次方向相反 |

> 第 1 条把 v2.6 的教训推到了该有的位置。
> v2.6 我写下"测试对系统状态的修改,必须由测试自己收回",但**只落实到密码上**。
> 真正的规则是:**它改了什么,就要能收回什么** —— 密码、节点、所有者、状态,一样不少。
> 而且收回不能只写在"正常路径的末尾"(那时的 `finally` 都还没写),
> 否则一旦中途抛异常,收回本身也跑不到。
>
> 第 3 条还说明:**断言"太严"和"太松"一样危险**。它一直绿着,不是因为性质成立,
> 而是因为没有被污染过。这类断言在干净的开发机上永远发现不了问题 ——
> 它只在"库被用过一段时间"之后才现形。

---

### 9.8 v2.8:为什么"改了两次还是小"(2026-09-27)

用户第三次反馈字体问题,并且说了一句关键的话：

> 「你能不能找几个好点的网站去参考一下,就常规的博客网站也行,或者直接去看看 confluence 是如何做的。」

**这句话点破的不是字号,是方法。** 前两次我都在**拍脑袋调数值**：
第一次调控件尺寸,第二次定了个"四档刻度"——但那个刻度**没有任何外部依据**,
于是我把它定成了 11 / 12 / 13 / 14,还把 tab、目录、评论这些**组件级文字**
归进了"次级信息"。用户看到的"还是小",就是这套自造刻度的直接后果。

| 我拍的 | 规范说的 |
|---|---|
| 最小 11px | Atlassian 的最小字号是 **12px**(他们特意从 11 提上去的,理由是可读性) |
| tab / 目录 / 评论 = 12px「次级信息」 | 它们是**组件级文字**,ADS `font.body` = **14px**,而且"配合图标时用 Medium 字重" |
| 12px 可以给"次级信息"用 | ADS 说 12px `body.small`「**谨慎使用**,仅用于次级信息,如细字印刷」 |
| 正文 15px | ADS `body.large` = **16px**,Confluence 编辑器正文也是 16px |

> **教训：定"刻度"这件事本身需要参照。**
> 自己发明一套看起来很有条理的 11/12/13/14,和在真实产品里被验证过的
> 12/14/16,差别不在数字,而在**依据** —— 前者只是把"我觉得"排了序,
> 后者能回答"凭什么"。
>
> 这也解释了为什么第一次和第二次的修改都"看起来有道理"却都不对：
> 两次我都在**优化一套没有依据的体系**。

#### 同一轮里抓到的五个非字号缺陷

值得单独记的原因是：它们**都不属于字号**,但都会被笼统地说成"UI 很丑"。
如果只盯着字号改,这些永远不会被发现。

| # | 现象 | 真正的根因 |
|---|---|---|
| 1 | 页头元信息被挤成 3 行,「更新于 2026/9/27」与「02:35:15」被拆成两截 | **谁和谁抢同一行**:元信息嵌在标题的 `flex-1` 里,被右侧按钮挤到只剩一百多 px。挪出去就一行放下 |
| 2 | 页头 / 卡片 / 编辑器左边框对不齐 | 三种横向内边距混用(24 与 32px)。**对齐问题看起来像"脏",但代码里没有任何一处是错的** |
| 3 | 侧栏底部三段常驻灰字 | "信息架构没做、用说明书补"。说明应该在**需要它的那一刻**出现(拖拽时),否则它只是噪音 |
| 4 | 组节点打开是空白编辑器 | 它下面是"没有正文"而不是"什么都没有"。Confluence 在这里列子页面 |
| 5 | 树看不出层级 | 只有缩进没有**引导线**。层级要靠数像素去猜,就等于没有表达出来 |

> 第 1 条尤其值得记：**"太挤"和"字太小"在观感上是同一件事。**
> 用户说"小",有时候不是字小,而是**这一行本来就不该放这么多东西**。
> 只看 `font-size` 会一直找不到病根。
>
> 第 2 条同理：**对齐错误不会报任何错**,它只是让界面显得不专业。

### 9.9 v2.10:这一轮踩的三个坑(2026-09-27)

三个都不是产品逻辑问题,而是**环境与工具的问题** —— 它们的共同特征是
"看起来像功能坏了",所以值得单独记下来。

#### 1. 本机 pnpm 装完之后**缺符号链接**,而它报 "Already up to date"

`pnpm add @tiptap/extension-code-block-lowlight lowlight` 失败在 esbuild 的
postinstall(`EBUSY`)。加 `--ignore-scripts` 之后命令成功、`node_modules` 里也有
`lowlight`,但 `@tiptap/extension-code-block-lowlight` **始终解析不到** ——
而 `pnpm install` 一口咬定 "Already up to date"。

查下来是两层缺链接:

- **应用层**:`apps/web/node_modules/<包>` 根本没建;
- **store 内层**:包的**依赖**也没建。第二层更阴险 ——
  报错指向 `node_modules/.pnpm/.../dist/index.cjs`,看起来像"这个包坏了",
  其实只是它的依赖没链上。而且是**传递**的:
  `lowlight → devlop → dequal`,只修第一层照样报
  `Cannot find package 'dequal'`。

处置:`scripts/fix-pnpm-store-links.mjs` —— **以 `apps/web/package.json` 为准**逐个核对直接依赖,
再沿依赖图递归补 store 内层的链接。以 package.json 为准这一点是关键:
手工列包名的话,漏一个就表现为 `Cannot find module '@tiptap/extensions'`,
而这看起来**像代码写错了**(实测就被误导过一次)。

工具里另外记了两条 Windows 特有的坑:`fs.realpathSync()` **不解析 junction**,
以及 `@scope/name` 在 store 里的那一层要**上溯两层**(不能只 `dirname` 一次)。
两条都是"不报错、只是把东西放错地方"。

#### 2. 我写的"顺手清理"删掉了 7 条**合法**链接

第一版修复脚本带了一段自愈:把"作用域目录里除了本包之外的非 `@` 开头的条目"
当成误建物删掉。**那个判断是错的** —— `apps/web/node_modules/@tiptap/` 下本来就该有
core / react / starter-kit 等 8 个包,它一次删掉 7 条合法链接。
(junction 只是摘链接不动实体,所以从 store 原样恢复了,没造成实际损失。)

> **教训:清理逻辑的删除条件必须能从"正确状态"推导出来,不能从"看起来多余"推导。**
> 一条修复环境的脚本,一旦自己会误删,它就比它要修的故障更危险。
> 现在这个脚本**只建不删**。

#### 3. 只在 `finally` 里 `process.exit(0)`,把失败变成了"正常结束"

验证脚本的日志停在半截、退出码 0。原因是 `finally { ...; process.exit(0) }`
**抢在错误打印之前**结束了进程 —— 一次真的失败(我的断言表达式里写了个
`code 的 class` 这种带空格的键名)看起来像跑完了。

> 同类问题的通用形态:**任何"统一收尾"都必须先把错误接住再收尾**,
> 否则收尾动作会把失败的证据一起收走。

#### 4. 一个把"验证顺序"变成结论的教训

链接验证一开始是失败的:落库的 JSON 里找不到那个链接。查下去发现是
**我的验证步骤自己造成的** —— 为了测"编辑已有链接",脚本把链接文字选中了,
紧接着插入表格时,表格**替换掉了那个选区**,于是链接没了。
产品是对的,流程是错的。

> 改成**每个功能做完就立刻验它的持久化**,而不是攒到最后一起查。
> 攒到最后,前面步骤的副作用会污染判断,而那时候已经看不出是谁干的。

---

## 10. 为阶段二预留的六条硬约束

**阶段一可以不做协同,但必须按这些约束写。违反任何一条,阶段二都要返工。**

| # | 约束 | 违反的后果 |
|---|---|---|
| 1 | **房间标识用 `node_id`** —— 一篇文档一个 Y.Doc | 用 slug 或 URL 做房间名,文档改名后协同直接断 |
| 2 | **正文存结构化文档树,绝不存 Markdown 字符串** | 阶段二整个内容层推倒重来 |
| 3 | **WebSocket 握手校验页面写权限**,只读用户标记 `readOnly`,服务端丢弃其 update | 只读成员能绕过前端直接改文档 |
| 4 | **结构操作(改名 / 移动 / 删除)走 REST + 乐观锁,不进 CRDT** | 这类操作在 CRDT 里无法收敛,会出现幽灵页面 |
| 5 | **落库策略:最后一人离开立即存,或静默 2 秒防抖存**;版本快照按每 10 分钟或每 500 次更新打点 | 协同产生的更新量远超单机,没有策略会丢数据或撑爆日志表 |
| 6 | **Yjs 二进制快照不能直接检索**,落库时同步拍纯文本 | 接上协同后检索全废 |

### 10.1 阶段二接协同时必须同步改的地方(备忘)

- 关闭 Tiptap 自带的撤销栈,改用 `Y.UndoManager`,否则两套撤销栈打架。
- `node_contents.ydoc_snapshot` 开始写入,与 `content_json` 并存一段过渡期。
- 权限变更需要通过协同网关广播,让在线用户立刻感知降权,而不是等 Redis TTL。
- 检索从 `pg_trgm` 换到 Meilisearch。

---

## 11. 风险与开放问题

### 11.1 阻塞项

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | ~~备份介质未落实~~ | **已接受风险(2026-09-26)** | 用户明确表示此事自己无法决定,**暂不处理、无须再提**。现状留档:`scripts/backup.sh` 只写到服务器本机 `./backups/`,与数据同盘 —— 该盘整体故障时数据与备份会一起丢。风险已如实告知,由用户知悉并接受 |
| 2 | ~~与既有知识库项目的关系未界定~~ | **已关闭(2026-09-26)** | 用户已明确放弃该项目,并已连同其在服务器上的全部数据、备份与镜像一并移除 —— 迁移问题不复存在,原「替代 / 并存」之争作废 |

### 11.2 技术风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 单机部署无冗余 | 本地卷存附件,机器坏了附件就没了 | 备份脚本 + 异地保存;附件目录单独挂盘 |
| **回收站保留策略误删** | 到期即**物理删除**,不可逆。判定的方向写反(把"满 N 天"写成"不足 N 天")会一次性清空整个回收站,而日志上只显示"清理成功" | ①判定抽成纯函数 `isPastRetention` 并单测边界;②`retentionDays <= 0` 即**关闭**整条自动清理;③手工接口支持 `?dryRun=true` 先空跑;④**每次清理都写审计**(`node.purge.auto`,带标题与子树大小);⑤验收脚本断言"刚删的节点不会被清掉" |
| 大文档编辑器性能 | 几千行的页面,Tiptap 首次渲染会卡 | M4 压测;必要时引入分块加载,但那是阶段二的事 |
| `pg_trgm` 检索精度 | 对长文档的相关度排序不如专业搜索引擎 | 阶段一可接受;阶段二换 Meilisearch |
| 中文分词 | 已在 §2.3 给出方案,但 `ILIKE '%x%'` 在超大表上仍需注意 | 阶段一数据量下无虞;上量后必须迁 Meilisearch |

### 11.3 待确认(不阻塞开工)

#### 已关闭(v2.4 · 2026-09-26)

- ~~附件单文件大小上限、允许的扩展名白名单~~ → **已定稿**:白名单
  `.png / .jpg / .jpeg / .gif / .webp / .avif`(**不含 SVG** —— 它能内嵌 `<script>`,
  是典型的存储型 XSS 载体),单文件 ≤ 10MB。
  两个值都是**代码里的常量**,不做成环境变量:放宽白名单是安全决策,
  不该靠改一个配置就能办到。
- ~~回收站保留天数~~ → **已定稿:30 天**,可用 `TRASH_RETENTION_DAYS` 覆盖。
- ~~回收站未做自动清理~~ → **已实现**(`RetentionService`,默认每 6 小时扫一次)。
  它与手工「彻底删除」**共用同一份删除逻辑**(`NodeService.purgeSubtree`)——
  写两份的话,总有一天其中一份会漏掉"按深度从叶子往根删"那个外键约束的坑,
  而那个坑不报错,只表现为"偶尔删不掉"。
- ~~`Cmd+K` 与模态弹窗并存~~ → **已修**:新增全局模态计数(`apps/web/src/lib/modal-store.ts`),
  有模态时快捷键不再叠加。用计数而不是布尔 —— 布尔量在两层模态嵌套时会提前解锁。
- ~~**节点成员管理入口**~~(v2.3 欠项,当时列为下一轮第一优先)→ **已实现**,
  见 §7.2 与 §8.5。它是「增量导入无法表达调岗」那条限制的配套,
  不是可选优化 —— 少了它,调岗只有一半路径走得通。

#### 仍然开放

- **是否需要"仅创建者可见的草稿"这一状态**(数据模型已预留 `draft`,阶段一未启用)。
- **移动端**:阶段一完全不做,但要提前确认"同事会不会真的在手机上查文档";
  如果是刚需,响应式布局的成本要提前排进去。
- **附件的孤儿文件**:上传了但没插进文档的图片不会被回收。阶段一不处理(数据量小,
  而清理需要引用计数)。若磁盘开始吃紧,再考虑按 `updated_at` 扫描 `content_json` 反查。
- **`?root=` 已经能用,但前端还没用它**。左侧组织树仍然一次性拉全量。
  这是**刻意的**:按需加载要配虚拟滚动、展开态与服务端分页的同步,是独立一块工作量。
  接口先留好形状,是为了将来改的时候不用动契约 ——
  **不要把这一条读成"规模问题已经解决"**,它只解决了"将来要改时不必动接口"。
- **重置密码之后,目标用户不会收到任何通知**(v2.6 新增的一项)。
  目前他只能靠"下次登录时被要求改密"察觉有人动过他的密码。
  更严的做法是"重置后给本人发通知"或"双人审批才能重置",
  两者都建立在**通知中心**上,而通知中心是阶段二的事(§10 已把它列为硬约束之一)。
- **打包体积涨到 871KB(压缩后 275KB)**(v2.10 新增)。
  来源是把编辑器能力补全:语法制导的 18 个语言文件(highlight.js 自带 190+,
  全量引入会再大几百 KB)+ ProseMirror 的表格模块。
  这**不是 bug**,但已经超过 Vite 默认的 500KB 提示线,值得在阶段二之前处理。
  方向有两个:①**按需加载语法**(用到某个语言才 `import()` 那一个语法文件,
  再把 highlight 结果换成异步的 —— 需要处理"先渲染纯文本、高亮到了再替换"的闪烁);
  ②把编辑器整块做路由级 `lazy()`(但正文页是主场景,收益有限)。
  **不要**靠"再砍几个语言"来压 —— 那是在砍能力去换一个数字。
  在通知中心落地之前,这条张力靠两件事兜着:**每次重置都进审计** +
  **重置会踢掉他的会话** —— 见 `DEPLOY.md` §10.2.1 的完整说明。
- **导出的 PDF 格式**:接口留了 `?format=`,目前只实现 `md`。PDF 需要额外依赖
  (无头浏览器或 wkhtmltopdf),要不要为它把一个几百 MB 的依赖塞进镜像,值得单独决策。
- **自动清理删掉的东西,只有审计日志里有痕迹**。管理员能在 `/audit` 看到
  `node.purge.auto`(actor 为空,带标题与子树大小),但**原作者看不到**
  "我写的那篇被系统到期清掉了"。要补这个得做通知中心,那是阶段二的事。
- **成员弹窗没有分页与搜索**。一个部门下几百人时,「下属成员」那一段会很长。
  阶段一的组织形态是"部门 → 组"两层,几百人同属一个部门是正常量级 ——
  等真出现这样的实例再补,现在加是过度设计。

**v2.0 新增的四项:**

- **审计覆盖面(v2.0 重写)**:v1.x 的缺口是"空间成员变更不留痕"(当时受模块环所限,写入侧已拆成
  纯函数 `audit/record.ts` 解环)。v2.0 起要留痕的变成三类,**都在 §9.2 批次三里**:
  ①**所有者变更**(谁把某个组交给了谁);②**授权增删**(谁给了谁编辑权、谁收回了);
  ③**组织归属变更**(谁把谁调进了哪个部门)。这三类比原来的"成员增删"更该留痕 ——
  它们直接决定"谁能改什么",一旦出事是要追责的。
  v2.4 补上第四类:**节点级的成员增删**(`org.member.add` / `org.member.remove`),
  以及系统自己的动作 `node.purge.auto`(actor 为空)。
- **保密能力(读全员开放的代价)**:v2.0 明确读对所有登录用户开放,系统**不提供任何保密手段**。
  这是有意的选择,但**首次部署时必须明确告知使用者** —— 避免有人把敏感内容(薪酬、合同、
  个人材料)当普通文档写进去。若将来真出现保密需求,那是**权限模型级的设计变更**,不是加个开关。
- ~~组织架构怎么进系统~~ → **已定稿(v2.1)**:Excel **增量**导入。模板列设计、匹配规则、已知限制全部写在 §8.5。
- ~~节点树的规模上限~~ → **接口形状已就位(v2.4)**:`GET /org/tree?root=<id>`,只返回那棵子树。
  仍开放的部分见上面第 4 条 —— 前端还没真正用上它。

**v2.2 新增的两项:**

- **登录标识要不要再留一个可选邮箱**:v2.2 起用工号登录,`users` 表已无邮箱列。
  阶段二的通知中心若要做"邮件提醒",需要再加一个可选的 `email` 列。
  **现在不加** —— 免得留一个没人用的字段;等真要做通知时再加。
- **初始密码全员相同的风险**:按用户要求统一 `123456` + 首登强制改密(§6.1.2)。
  三条缓解措施已落实,但**在某人首次登录改密之前,知道他工号的人仍可登进他的账号**。
  若要更严,可改为"管理员生成一次性激活码、批量导出后分发"——需要额外的字段与界面。

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
| 2026-09-26 | v1.6 | ①**§9 的 M3 全部勾选完成**,并补齐两段实测口径(接口层 55 项 + 直接查库 11 项)。②**§8.1 补「实现要点」**:一条 UPDATE 递归重建路径的写法、用路径前缀做防环(以及末尾斜杠不能省的原因)、`substring(x from $n)` 的**静默 NULL 陷阱**(必须改写成 `substr(x, $n::int)`)、软删除只标记未删行(否则 `removedCount` 虚高)、彻底删除必须按 depth 从叶子往根删(`onDelete: Restrict` + `DELETE` 不支持 `ORDER BY`)。③**§5.4 矩阵新增**「彻底删除(不可逆)」一行(admin 起,门槛刻意比软删除高一级),`page.purge` 同步进 `CAPABILITIES`。④**§6.2 接口调整**:`GET /trash` → `GET /spaces/:id/trash`(回收站天然以空间为界,做成全局列表反而要额外处理跨空间权限)。 |
| 2026-09-26 | v1.7 | ①**M4/M5/M6 全部完成并实测验收**：端到端 76 项断言全通过、单测 299 项全绿、前端 8 个页面用无头浏览器实渲染确认（验收细节与踩到的坑见 §9.1）。②**§5.5 缓存失效改为空间级世代号**（与原方案不同，已写明理由：`SCAN` 既慢又可能漏，漏了就是静默越权），并补充「Redis 是可降级依赖，判定正确性不依赖缓存可用性」。③**§6.1 新增请求体上限 8MB 的说明** —— Express 的 JSON 解析器默认只有 100kb 而正文上限 2MB，不抬高会让长文档存不进去；同时说明 body-parser 的错误形状（它不是 `HttpException` 子类），过滤器必须显式识别，否则「请求体过大」会变成 500。并记录「不从传递依赖 `express` 里 import」这条教训。④**§4.3 新增 jsonb 行为说明**：jsonb 不保留键顺序，任何「内容有没有变」的判断必须按语义比。⑤**§8.3 补排序策略**（主键是命中位置而非 `similarity()`，因为中文两字查询的相似度普遍为 0）、**§8.4 补评论实现要点**（只允许一层回复、跨页面 `parentId` 拒绝、改正文与标解决是两套权限）。⑥**§7.4 补编辑器实现要点**：Tiptap 扩展必须声明为直接依赖、`content` 只在挂载时读一次、工具栏按钮要拦 `mousedown`、正文冲突用 `baseUpdatedAt` 而非 `pages.version`、不引入 typography 插件。⑦**§6.2 补 5 条接口**（导出、候选主体、评论计数、附件上传）。⑧**§11.3 新增 6 项待确认**：孤儿附件、PDF 导出、审计缺「空间成员变更」、`Cmd+K` 与模态叠加、回收站未做自动清理。⑨文档头状态改为「阶段一全部完成」。 |
| 2026-09-26 | v1.8 | ①**部署上线**:服务已部署至内网服务器,4 容器 healthy;在**部署实例上**复跑验收 76/76 通过,`scripts/backup.sh` 与 `restore-drill.sh` 亦实跑通过(10 张表逐表精确一致,全程不动生产库)。②**§11.1 关闭剩余的「备份介质」阻塞项** —— 用户明确表示此事自己无法决定,**暂不处理、不再追问**;风险现状已如实写入该行留档。阻塞项清零。③**§9.1 补记第 5 个真问题**:恢复演练原用 `pg_stat_user_tables.n_live_tup` 比行数,那是 autovacuum 维护的**估算值**,在刚恢复出来的库上与生产库不可比,会报出「备份坏了」的**假失败**;已改为逐表 `count(*)`。**假失败比没有演练更糟** —— 要么让人对好备份失去信任,要么让人对真问题麻木。④文档头状态改为「已上线」。 |
| 2026-09-26 | v2.0 | **权限与空间模型整体重做(组织架构驱动)**。用户指出初版把"空间"当成"用户自由创建的容器"是理解偏差 —— 实际它是**公司既有的组织层级**,且**读全员开放**。①**§1.1 定位重写**:新增"通用知识库 vs 本项目"对照表。②**§1.5 新增**:记录四条变更理由与影响面(作废三张表 / 改名两张 / 新增两张 / 不受影响六块)。③**§4 整体重写**:`spaces` / `space_members` / `page_permissions` 作废;`pages` → `nodes`(空间与页面**合并为一棵树**,加 `kind` / `owner_id`);新增 `org_assignments`(组织归属,多对多)与 `node_grants`(授权名单);删除 `users.department`(单值无法表达多归属)。④**§5 整体重写**:删除五档角色与 `CAPABILITY_MIN_ROLE` 查表,改为四个纯函数 `canRead` / `canEdit` / `canManage` / `canCreateUnder`;**删除 `deny` 与「最小可见」两条铁律**;新增「**授权受组织范围约束**」这一条规则(组长不能把权限给到别的部门的人)。⑤**§6.2 接口清单重排**:分认证 / 组织架构 / 节点 / 授权 / 评论 / 检索治理六组,权限列由"角色"改为"关系";新增组织架构维护 6 条接口。⑥**§7.2 路由**:登录**直达工作台**,删除 `/spaces` 与成员管理页,`/s/:spaceId/p/:pageId` → `/n/:nodeId`;权限设置由独立页面改为**节点级弹窗**。⑦**§8.3 检索取消权限过滤**(读全员开放的必然结果),并写明"**系统不提供保密能力**"这一代价。⑧**§9.2 新增**:v2.0 改造任务清单(四批次,约 14 个工作日)+ 六条新验收口径,并**明确标注 `pnpm verify:m4m5` 必须整体重写**(它的部分断言在新模型下本身就是错的)。⑨**§11.3** 新增四项待确认(审计覆盖面 / 保密能力 / 组织架构导入格式 / 节点树规模上限)。 |
| 2026-09-26 | v2.1 | **组织架构导入方案定稿(§8.5 新增)**。用户选定**增量**语义 —— 模板只做增量,删人走手工。①**三步两阶段**:下载带有当前数据的模板 → 上传得到**差异预览**(`dryRun`,不写库)→ 确认写入。预览与写入**共用同一份解析逻辑**,避免两边算出不同结果而管理员照着预览做决定。②**幂等保证**:同一份表格可反复上传,不会重复建号。③**新增 `节点ID(勿改)` 只读列** —— 用户明确"部门只会更名不会消失",若只用名称匹配,改名后会**自动创建一个重复部门**(旧部门及其文档仍在);此列成为匹配节点的第一依据,改名被正确识别为「更名」。④**已知限制写明**:增量语义下"表格里没写"与"要删掉归属"**无法区分**,故**调岗需要两步**(导入新归属 + 界面移出旧归属),为此新增**节点成员管理入口**任务(§9.2 批次三)。⑤**离职走界面而非表格**:`users.status` 增加第三档 `departed`,并要求在**该用户创建的页面上标注「已离职」**。⑥批次三 4 天 → 5 天,总计约 15 个工作日。⑦解析库选 `exceljs`(不选 SheetJS:其社区版安全历史问题较多,而上传解析正是攻击面)。 |
| 2026-09-26 | v2.2 | **登录标识由邮箱改为工号,并定稿密码策略(新增 §6.1.2)**。①**工号取代邮箱**:`users.email`(citext) → `users.employee_no`(text);登录入参、Excel 模板列、人员匹配键随之全改;`citext` 扩展不再需要。用 `text` 而非数字类型 —— 工号常带字母前缀与前导零(`KC2026007`),当数字存会丢信息。②**统一初始密码 `123456`**,服务端内置,**不进模板**;新增 `users.must_change_password`(默认 true)。③**新增 §6.1.2**:新密码 ≥8 位且须同时含字母与数字;**强制改密必须服务端拦** —— 全局守卫白名单(除 `/auth/change-password` 与 `/auth/logout` 外一律 403 `PASSWORD_CHANGE_REQUIRED`),只做前端跳转无效;强度校验**只在改密接口做**,登录时不做(否则收紧规则会让老账号登不上)。④**如实写明风险**:在某人首登改密之前,知道其工号的人可以登进他的账号;已落实三条缓解(强制改密 / 改密前无任何业务权限 / 登录失败不区分"工号不存在"与"密码错误")。⑤**§6.2 新增** `POST /auth/change-password`;`/auth/me` 返回 `mustChangePassword`。⑥**§8.5 模板**改为「工号 / 姓名 / 部门 / 组或项目 / 负责人 / 节点ID」,并明确**无密码列**。⑦**§7.2** 新增 `/change-password` 路由。⑧**§11.3** 新增两项(可选邮箱字段、初始密码风险与更严的替代方案)。⑨**认证模块由"保留"改为"需重做"** —— 文档头状态同步更正(原判断有误)。 |
| 2026-09-26 | v2.3 | **v2.x 模型全部落地并完成全量验收**。§9.2 四个批次全部完成;新增 **§9.3「改造中实跑发现的问题」**。①**数据模型**:迁移整体重建(旧的 v1 迁移作废 —— 模型变化是根本性的,而旧数据没有迁移价值);补充 `users.employee_no`、`must_change_password`,树的响应补 `version` / `status`(拖拽要用 `version` 做乐观锁,少了它前端只能"拖之前先拉一次详情",而两次读之间数据可能已经变了 → 静默落到错误位置)。②**权限服务**:`PermissionService` 成为唯一入口;`canGrantTo` 独立出来承担「授权受组织范围约束」;`access` / `requireEdit` / `requireManage` 增加 **`allowDeleted`** 参数(回收站三个操作必须能判定已删节点)。③**组织架构管理**:Excel 导入完整落地(模板 / 预览 / 写入);模板由一列 ID 改为 **「部门ID(勿改)」+「组ID(勿改)」两列** —— 一列在「组是新建的、而部门刚改过名」时会重复建部门;现有部门没写负责人时**保持原所有者不动**,并**不做任何兜底继承** —— 这两条都是为了保住「下载模板原样上传 = 零差异」这条性质,已写进单测。④**前端**:登录直达工作台;组织树替代页面树;节点级权限弹窗分三段(所有者 / 上级所有者 / 额外授权)。⑤**六个只有真跑才会暴露的问题**全部记入 §9.3:恢复与彻底删除因 `allowDeleted` 未下传而永远 404、`GET /auth/me` 漏出强制改密白名单导致用户卡在「无法连接到服务」、导入接口的权限检查排在文件校验之后、超管在界面上没有换部长的入口、模板 ID 列不够、组织架构页把文档标成「组长」。⑥**验收**:`pnpm verify:org` **85 项断言全通过**;单测 shared 13 / web 17 / api 147 = 177 项;前端 11 个页面用无头浏览器 + CDP 注入会话实渲染确认,页面内无 JS 异常;数据库契约自检按 v2 契约重写并加了一条「v1 的 5 张表必须不存在」的反向断言。⑦`pnpm verify:m4m5` 删除,§9.1 降级为历史记录并标注「口径不要照搬」。 |
| 2026-09-26 | v2.4 | **§11.3 的欠账清零 —— 补齐「节点成员管理入口」,并清掉三项遗留。** ①**节点成员管理(上一轮列为第一优先)**:新增 `GET/POST /nodes/:id/members` 与 `DELETE /nodes/:id/members/:userId`,以及 `/nodes/:id/member-candidates`;前端在组织树上加 `☰`、文档页加「成员」按钮,弹窗分「直接成员 / 下属成员」两段(只有直接成员能从这里移出,子孙的归属要到对应层级去动)。**读全员开放、写要 `canManage`(超管另行放行)**;加入时受组织范围约束;**移出只删那一条归属,不改变所有权**——但会缩小他的组织范围,这两个后果写在确认框里并有单测钉住(`removal-note.test.ts`)。②**成员候选人与授权候选人刻意分成两条接口** —— 门槛不同(后者超管不在其列),复用会出现「超管能改成员、但候选列表是空的」这种自相矛盾的界面。③**回收站自动清理**(`RetentionService`):默认保留 30 天、每 6 小时扫一次,可用 `TRASH_RETENTION_DAYS` / `TRASH_PURGE_INTERVAL_HOURS` 覆盖,**`<=0` 表示关闭**(自动删除用户数据这件事必须能被明确关掉);过期判定抽成纯函数 `isPastRetention` 并单测边界;超管可 `POST /admin/maintenance/trash-purge`(支持 `?dryRun=true` 先空跑);审计动作 `node.purge.auto`(actor 为空)。删除逻辑与手工「彻底删除」**共用 `NodeService.purgeSubtree`** —— 凡是删数据的逻辑只允许存在一份。④**组织树按根查询**:`GET /org/tree?root=<id>`;**只返回子树时仍要补查祖先参与判权**,否则子树里每个节点都会被算成"我改不了"且不报任何错 —— 验收里有一对断言专门守它(同一个叶子,部长能改、别部门的人不能改)。⑤**`Cmd+K` 模态冲突已修**:新增全局模态计数(`apps/web/src/lib/modal-store.ts`),用计数而不是布尔 —— 两层模态嵌套时布尔会提前解锁,表现是"关掉里层、快捷键却恢复了"。⑥**关闭四项待确认**:附件白名单与上限(图片 6 种 / 10MB,**常量不入环境变量** —— 放宽白名单是安全决策)、回收站保留天数、自动清理、`Cmd+K`。⑦**修正接口清单与实现的多处漂移**(`/org/departments` → `/org/nodes`、补 `/org/scopes` 与 `/nodes/:id/owner-candidates`、去掉回收站与人员列表上并不存在的查询参数)。⑧**新增 §9.4**,记录两处刻意取舍:成员与授权为何不合并、删除逻辑为何只允许有一份。⑨**验收**:`pnpm verify:org` 由 85 项扩到 **129 项**,新增 L(节点成员与调岗两步)与 M(保留策略与按根查询)两组;单测 177 → **193 项**;前端用无头浏览器 + CDP 实渲染并**驱动交互** —— 成员弹窗、以及"弹窗开着时按 Ctrl+K 不叠出命令面板"的行为断言。⑩**部署**:服务器实例复跑 129/129 通过。 |
| 2026-09-27 | v2.5 | **按用户实测反馈重做四处。** 用户的四条反馈原话:「页面整体的视觉效果非常差,图标、字体大小、字样都非常不对称」「评论只是评论,不是问题,你在页面中直接把评论列为问题,这个不对,**你不要擅自赋予评论额外的含义**」「重置密码,不需要输入原密码,直接输入新密码;用户在初次登录页面以后,无法回到 login 页面,必须改密码才行,这样是不合适的,**用户第一次登录,不应该记录登录状态**,重置完密码以后,应该要用户重新登录才对」。①**首次登录不再建立会话**(§6.1.2 整体重写):`POST /auth/login` 变成**两种结果**(`LoginResponse` 判别联合)—— 需要改密的账号**不下发 Cookie**,只给一张 10 分钟的一次性 `setupToken`(`base64url(payload).HMAC-SHA256`,无状态签名,复用 `SESSION_SECRET`,`SESSION_SECRET` 未配置时**明确报错不降级**);新增 `POST /auth/initial-password` 凭凭证改密,**不需要原密码**,成功后**仍不建立会话** —— 用户必须用新密码重新登录。②**删掉整套「改密白名单」机制**(`@AllowDuringPasswordChange()` 装饰器连同文件一起删除):不再存在"已登录但未改密"这种半登录态,白名单也就失去了存在意义;守卫里**保留一条纵深防御**(发现该状态就吊销会话并按未登录处理)。③**评论去掉「问题/已解决」语义**(§8.4 重写):删 `comments.status` 列(迁移 `drop_comment_status`)、删「标记已解决/重新打开」与「已解决」徽章、树角标从"未解决评论"(琥珀色)改为**评论总数**(中性灰 —— 琥珀色本身就在暗示"有待处理的事");`CommentView` 用 `canEdit`(仅作者)/`canDelete`(作者或祖先所有者)替代 `canResolve`,顺带修掉"所有者看得到「编辑」按钮却 403"。④**修树缩进**:`(depth > 2 ? 2 : depth)` 把第三级之后全钳成同一缩进,改为 `Math.min(depth, 8) * 13 + 6`。⑤**一轮视觉规范化**:抽出 `TOOL_BUTTON_CLASS`(工具栏 6 个按钮原先各有各的字号,`+`/`✎`/`×` 是 14px 而 `⊞`/`⚙`/`☰` 是 11px —— 这就是"字样不对称"的来源)、树行统一 `h-7`、树图标字号统一、工具栏内边距与正文对齐(`px-4` → `px-6`)、页标题 `text-2xl` → `text-xl`(24px 配 12px 元信息落差过大)。⑥**新增 §9.5**,记录这一轮实跑发现的三个问题,其中第 3 条(服务器验收失败而本地全过)的教训是**不要写依赖"历史记录还在"的断言**。⑦**验收**:`pnpm verify:org` 129 → **143 项**(A 组按新流程重写,含三条关键的否定性断言:首登不下发 Cookie、改完仍无会话、同一凭证不可复用;K 组改为自己制造 `org.import` / `node.content.update`,顺带在端到端层面验了「模板原样上传 = 零差异」);单测新增 `setup-token.spec.ts`(12 项,覆盖"换了 payload 但签名没变"这类伪造);本地与服务器实例**各跑 143/143**;前端用无头浏览器 + CDP 驱动交互确认(首登页只有两个输入框、有「返回登录页」、改完回登录页并显示提示、树缩进实测 `[6,19,32,45]` 每级 +13)。⑧**部署**:服务器已更新并复跑通过。 |
| 2026-09-27 | v2.6 | **由用户一句「测试账号没了?」触发的一轮 —— 补上一个缺失的能力,并修掉一个会反复咬人的缺陷。** ①**新增「管理员重置密码」**(§6.1.4 新增):`POST /admin/users/:id/reset-password`。此前系统里**根本没有**"同事忘密码"的出口,唯一的办法是运维进容器连数据库改哈希 —— 既不该是运维的活,也不留任何痕迹。一次重置做三件事:写回初始密码 `123456`、置 `must_change_password = true`、**吊销他全部会话**(漏掉第三条,"重置"在管理员心里就不成立 —— 那是"我把他踢出去了");两条刻意的拒绝:**不能重置自己**(能点按钮就说明他已经登进来,允许只会制造一次手滑)、**不能重置已离职/停用的人**(重置了也登不进来,错误信息直接点出真正原因)。②**验收脚本改为幂等**(`verify-org.mjs` 新增 N 组):A 组为验首次改密**必须真改** KC003 的密码,`login()` 还会顺手改 KC004,而**此前没有任何地方还原** —— 后果是①文档里写的 `123456` 登不上(用户直接撞上)②下一轮 A 组走"跳过"分支,总项数 160 → 148,看着像回归,其实是上一轮脚本自己造成的。现在 N 组结尾用新接口把两个账号放回去,并顺带断言这个接口本身(越权 403 / 不能重置自己 400 / 重置会吊销已有会话 / 重置后仍不下发会话 / 重置离职者 400 并复原)。实测:**本地连跑三次 148 → 160 → 160,服务器连跑两次都是 160**。③**修掉一处判权缺口**:`GET /admin/users` 此前**根本没有判权**,任何登录用户都能拿到全公司名册(而文档一直写的是超管)—— 是加 `mustChangePassword` 时暴露的,那个字段等于一份"谁的密码还是 123456"的目标清单。已按文档收紧为超管专属;「这个部门里有谁」仍走 `GET /nodes/:id/members`(读全员开放)—— 公开的是**组织归属**,不是账号状态与登录时间。前端 `/admin/*` 补一层 `RequireSuperAdmin`(只负责体验,非安全边界)。④**`OrgUserView` 增加 `mustChangePassword`**,人员管理页对这类人标「初始密码未改」(带 tooltip 说明后果)。⑤**实渲染验证抓到一个跨模块的文案缺陷**:`window.confirm` 是纯文本,写给 Markdown 看的 `**加粗**` 会把星号原样显示出来 —— 新增的重置确认框**和 v2.4 就有的「移出成员」确认框**都中招。两处一起改掉,并各加一条断言把这类符号钉死(§9.6)。⑥**人员管理页表格列对齐**:姓名列原为 `flex-1`,后面多一个徽章就被挤窄,同表各行姓名起始位置不一致;徽章也改为定宽槽位;`上次登录` 与 `状态` 因此各归其位;重置按钮改用 `Button variant="danger"`(顺带修掉"同一行两种按钮高度不同");页面容器由 `max-w-4xl` 放宽到 `max-w-6xl` —— 九列的表在 4xl 里会挤到折行。⑦**验收**:`pnpm verify:org` 143 → **160 项**;单测 212 → **220 项**(shared 13 / web 32 / api 175,新增 `reset-note.test.ts` 与 `removal-note.test.ts` 的纯文本断言)。⑧**部署**:服务器已更新并复跑两次 160/160。 |
| 2026-09-27 | v2.7 | **定死字号刻度,并让规则由机器执行(§7.5 新增)。** 触发点是用户**第二次**反馈「字体太小了」——在截图上圈了左栏、右栏、主区三处,并标注主区"字体正常"。说明问题不是某一处,而是**没有刻度**:全项目当时有 9 / 10 / 11 / 12 / 13 / 14 六个档混用,每一处单看都有理由,合起来就是"不成比例"。①**四档刻度**:正文 15px(`.kc-prose`)/ **内容 14px**(组织树的行、右栏目录项、评论正文)/ **次级 12px**(标签、提示、时间、tab、面包屑)/ **徽章 11px**(唯一的任意值)。判断只有一句:**它是"内容"(要被读)还是"标签"(要被认出)?** 左栏树行两次被指"太小",就是因为它明明是内容(13px)却按标签的尺寸在写。②**刻意不留 13px**:起草时写了五档并给"次级"单开 13px,写完才发现代码里已有 **64 处 `text-xs`(12px)** —— 要么大改、要么这一档是空文。**多一档就多一次分歧的机会**,于是退回四档(理由写进 `lib/typography.ts`)。③**规则由机器执行**:新增 `apps/web/src/lib/typography.ts`(刻度)+ `typography.test.ts`(**扫描源码**,断言无 <11px、无 11px 以外的任意值字号)。扫描器**刻意不区分注释** —— 注释掉一行照样被查到,规则没有绕过的余地;代价是写注释时换一种说法(这一条也写在测试的注释里)。④**全量对齐**:清掉 17 处 `text-[10px]` 与 1 处 9px(树上的展开箭头 ▾/▸ —— 9px 几乎看不出是箭头),左栏树行 13→14px、行高 `h-7`→`h-8`、面板宽度 288→320px,右栏目录项与评论正文 12→14px,顶栏与各类徽章同步对齐。⑤**修掉放大字号带来的副作用**:树行的 6 个悬停按钮原为 `flex-none` **常驻在流里**(吃掉 130~160px),字号变大后「CRM 项目概览」被截成「CRM 项…」。改成**绝对定位的悬停覆盖层**,实测 **8 个标题零截断**、悬停前后标题宽度完全一致(245px → 245px,无布局跳动)。⑥**验证**分两层:源码扫描(CI 内)+ **运行时核对**(无头 Chrome 遍历每个叶子文本节点断言计算字号 ≥11px)—— 6 个页面 + 2 个弹窗全部为 0,可拦住源码扫描漏掉的继承与特例。⑦**反思写进 §9.7**:用户说"字体太小",正确的问题是「**这里的字应该是几号?依据是什么?**」,而不是「这一处调到多少才好看?」—— 前者产出一个刻度表和一条检查规则,后者只会产出更多各有理由的数字,然后必然有第三次反馈。⑧**顺带修掉验收脚本自身的两个缺陷**(部署时在服务器上暴露,3 项失败**都不是产品问题**):**(a) 只还原密码、不还原节点与所有者** —— v2.6 的教训只落实了一半,一次崩溃的运行把「后端组」所有者改成赵敏并留下 3 个测试节点,于是下一轮从 C 组开始失败、看起来像功能坏了;新增 `restoreToolState()`(密码 + 残留节点 + 被改的所有者),正常路径在 N 组调、异常在 `finally` 兜底、**开头还自检残留并自动清掉**。**(b) 断言太严而一直假绿**:「赵敏看不到别人节点上的授权变更」只查"日志里有没有 `grant.replace`",可她**自己合法做过的**授权变更本来就该出现(审计可见性规则是"我是操作者或目标在我管辖内")—— 它能通过只因干净的库里恰好没有反例。改为按操作者过滤。**(c)** I 组的 `.body.some(...)` 在中途失败时会抛异常打断脚本、连收尾还原都跑不到(库越跑越脏),抽出 `arr()` 兜底并把 `main()` 包进 `try/finally`。⑨**验收**:单测 220 → **223 项**(web 32 → 35);端到端 160 项,本地与服务器**各连跑多次,项数恒定、零失败**;运行时长字号扫描在服务器实例上同样是 0 处 <11px。 |
| 2026-09-27 | v2.8 | **按 Atlassian Design System 与 Ant Design 的公开规范重做字号与排版(§7.5 重写)。** 触发点是用户**第三次**反馈字体问题,并且说了一句点破性质的话:「你能不能找几个好点的网站去参考一下…或者直接去看看 confluence 是如何做的」—— 前两次我都在**拍脑袋调数值**,第二次甚至自造了一套"11/12/13/14"的刻度,**没有任何外部依据**。①**查到的规范**:Atlassian Design System 的 `font.body.large` = **16/24**(长文)、`font.body` = **14/20**(组件默认,"配合图标时用 Medium 字重")、`font.body.small` = **12/16**("谨慎使用,仅用于次级内容如细字印刷");Confluence 视觉改版明确写着「把最小的标题与正文字号**从 11px 提到 12px**」,编辑器正文 16px。Ant Design 基础字号从 12 提到 14,中文行高 1.5–1.8,字阶控制在 3–5 种。②**纠正两个硬错误**:最小字号 11px → **12px**(11 比 Atlassian 的下限还低);把 tab / 目录 / 评论这些**组件级文字**从 12px 提到 **14px**(它们不是"细字印刷")。③**新刻度**:正文 16/1.7、内容 14/20、组件标签 14/20 + medium、元信息 12/16 —— 三档数值与 ADS 的 `body.small` / `font.body` **完全一致**,因为 Tailwind 的 `text-xs`(12/16)与 `text-sm`(14/20)恰好就是这套值。**规则收紧为"不允许任何任意值字号"**(v2.7 还留了一个 11px 例外,那一档已被规范否掉)。④**显式字体族**:系统字体 + 中文字体按平台覆盖(PingFang SC / Microsoft YaHei / Noto Sans SC),避免"某台机器上难看"。⑤**修掉五个非字号缺陷**(这些都是"看起来像丑、代码里没有一处是错的"):页头元信息因与右侧按钮**抢同一行**被挤成 3 行且日期被拆成两截;页头/卡片/编辑器混用三种横向内边距(24 与 32px)→ 统一 32px;侧栏底部**常驻三段灰色说明文字**(信息架构没做、用说明书补)→ 拖拽说明改为只在拖拽时出现;「组/部门」节点打开是**一块空白编辑器** → 补 `ChildPages`(Confluence 在空间首页列子页面);树只有缩进、没有**层级引导线** → 补上并与上一级展开箭头对齐。⑥**验收脚本第四个漏洞**:脚本会真的**移出某人的组织归属**(L 组验"组员不能移出别人"时目标就是王思远),而收尾只还原密码 + 节点 + 所有者,**归属没收** —— 服务器上王思远的「后端组」真的丢了,表现成"组长改不动自己组里的东西"。新增 `EXPECTED_ASSIGNMENTS` 归属基线,收尾还原 + **开头自检**。至此"脚本改什么就收回什么"覆盖了密码 / 节点 / 所有者 / 归属四类。⑦**一处差点误删**:清理残留前先查创建时间与父子关系,发现 `视觉项目组`(含一个三级页面)**是用户自己建的**(他用来复现更早那个"第三级没缩进"的问题)—— **清理必须按时间/归属区分"用户建的"与"测试建的",不能按标题猜**。⑧**新增 §9.8**,记录这一轮的核心教训:**定"刻度"这件事本身需要参照** —— 自己发明一套看起来很有条理的 11/12/13/14,和被真实产品验证过的 12/14/16,差别不在数字,而在依据;以及"太挤"与"字太小"在观感上是同一件事,只看 `font-size` 会一直找不到病根。⑨**验收**:单测 **223 项**全绿;端到端 160 项,本地与服务器**各连跑两次均 160/160**;运行时字号扫描(遍历每个叶子文本节点断言 ≥12px)5 页面 + 3 弹窗**全部为 0**,并读回关键计算字号(树行 14 / tab 14 / 目录项 14 / 评论正文 14 / 正文 16 / 标题 24)。 |
| 2026-09-27 | v2.9 | **补上「点击目标尺寸」下限(§7.5)。** 触发点:用户唯一剩下的不满 ——「把这个展开符号搞大一点,不然鼠标点着太费劲了」(截图圈的是组织树里的展开箭头)。它与字号问题同源但**不是同一件事**:那处控件是**点击目标**,不是文字,所以"最小 12px"这条规则管不到它。①**字形 12px 的 Unicode `▾`/`▸` → 16px 的 SVG 雪佛龙**:Unicode 三角在大多数字体里**垂直居中偏移**(下缘比上缘空),看着比字号更小,而且换字体就换样子;SVG 的尺寸与居中自己控制,放大不糊,顺带加了 150ms 旋转过渡。②**点击区 20×20 → 24×24**:24px 是公认下限(Apple HIG 与 WCAG 2.2 的 Target Size 都是 24px),低于它对鼠标就是不友好 —— 用户说的"费劲"是准确的;树行高 36px,放得下。③**悬停反馈从"只有字形变色"改成"字形加深 + 24px 圆角底色"**:只变色的话用户仍不知道该往哪儿瞄准,底色把"可点范围有这么大"直接画出来。④**加 `aria-expanded`**,并补 `focus-visible` 焦点圈(此前键盘用户完全看不到焦点在哪)。⑤**改动最小的证明**:加宽点击区会让整列(徽章、标题、层级引导线)右移 4px,所以把行的 `paddingLeft` 常数从 `6` 减到 `4` —— `4 + 24/2 = 16` 与原先 `6 + 20/2 = 16` **完全相等**,引导线公式一个字没改。实渲染实测:点击区 4 个全部 `24×24`、字形 `16×16`、无子节点的行占位同为 24px(徽章仍对齐)、箭头中心与引导线 x 坐标**逐行相等**(16 / 29)、悬停前后标题宽度不变(237 → 237px,无布局跳动)、点击一下行数 7 → 3、再点一下回到 7、控制台零异常。端到端 160 项、单测 223 项全绿,本地与服务器均已更新。 |
| 2026-09-27 | v2.10 | **补齐编辑器的三处能力缺口(§7.4 重写该节)。** 三条都是用户实测反馈,共同点是**控件本身没坏,是"做不成事"**:①「添加链接竟然是弹窗输入链接,这个不太对」—— `window.prompt` 除了观感,有三件事**做不到**:只有一个输入框(定地址与定文字要分两次)、不能校验(`javascript:` 与 `data:` 会被直接写进文档)、编辑已有链接时看不到原文。换成贴着按钮展开的气泡:地址 + 显示文字两个字段、提交前归一化与校验、打开时回填、以及「移除链接」。地址归一化抽成纯函数 `link-url.ts` 并有单测,其中最易错也最难发现的一条是**站内路径(`/n/…`)与 `#锚点` 绝不能补 `https://`** —— 补了会把"跳到另一篇文档"悄悄改成"跳到外网站点",而且不报错。②「表格默认三行三列,不支持扩展」—— 补上行列增删、合并/拆分、表头切换、删除表格。实现上**收进一个菜单而不是铺一排按钮**:要补的操作有十来个,而正文列只有 `1084-320-320 ≈ 444px`,v2.8 已经因为折行踩过一次。做成**一个按钮两种状态**:不在表格里时只做"插入"(带 6×6 网格选行列数),光标进了表格同一个按钮高亮、菜单里多出「表格工具」;`合并/拆分` 用 `editor.can()` 判可用性并给出**说明为什么不可用**的 title。③「代码块不支持语言能力指定」—— 挂 `CodeBlockLowlight` + 18 个语言的语法高亮。三处要点:**必须关掉 StarterKit 自带的 `codeBlock`**(同一节点两份实现会冲突,表现为"语言存不住、类名时有时无");**语言清单与高亮注册表必须是同一份数据**(下拉里有、注册表里没有 => 选了语言却不着色且**不报错**,所以注册表由 `CODE_LANGUAGES` 推导并加单测断言);**原始语言不能直接交给 lowlight** —— 实测确认它对未注册语言**抛错**而不是原样返回,一篇带 ` ```brainfuck ` 的文档会让渲染炸掉,故界面上一律先过 `normalizeLanguage()`,但下拉里**照实显示「brainfuck(未识别)」**而不装作是纯文本。顺带修掉一个"看起来偶发"的老问题:**工具栏激活态滞后** —— `isActive(...)` 是"此刻光标在哪"的函数而 `onUpdate` 只在内容变化时触发,于是"点进代码块看不到语言下拉、光标移到加粗文字上 B 不亮",订阅 `onSelectionUpdate` 后正常。**环境层面**另有三处记录在 §9.9:本机 pnpm 装完**缺符号链接**(应用层 + store 内层,且是**传递**的:`lowlight → devlop → dequal`)而 `pnpm install` 报 "Already up to date",处置脚本 `scripts/fix-pnpm-store-links.mjs` **以 package.json 为准**逐个核对(手工列包名漏一个就表现为 `Cannot find module`,看起来像代码写错了);我写的"顺手清理"曾**误删 7 条合法链接**(把 `@tiptap/` 作用域目录里的其它包当成垃圾),所幸 junction 只摘链接不动实体 —— 教训是**清理逻辑的删除条件必须能从"正确状态"推导,不能从"看起来多余"推导**,该脚本现已只建不删;以及验证脚本只在 `finally` 里 `process.exit(0)`,**把一次真失败变成了"日志停在半截但退出码 0"**。**验收**:新增 17 项单测(web 35 → 52,含语言清单/注册表一致性与地址归一化);端到端 160 项仍全通过;实渲染 + 驱动交互逐项确认 —— 链接气泡两个输入框且点外面会关、落库的 mark 为 `href: https://wiki.internal/规范`(自动补协议)、表格 4×4 插入后插行 5→6 行插列 → 5 列且落库为 `6 行 × 5 列`、代码块 `language-javascript` 产出 `hljs-keyword/hljs-number/hljs-comment` 三个 token 且切到 python 后属性与类名同步变化、控制台零异常。**代价**:打包体积约 600KB → **871KB(压缩后 275KB)**,已在 §11.3 记下"按需加载语法"这条优化方向。 |
| 2026-09-27 | v2.11 | **文档与代码对账,并把检查固化成 `pnpm audit:docs`(新增 §0.5)。** 触发点是用户一句「现在文档和代码功能是否对齐了?」—— 这个问题不该靠印象回答,所以做了一次实际对账,查出 **7 处真实漂移**:①**§9.1 自相矛盾** —— 同一段里既写「`pnpm verify:m4m5`(已删除)」又写「验收脚本在仓库里…可以自己复现」,后半句是 v1.x 的说法,留着一份**声称能复现但实际复现不了**的数字是最坏的一种文档状态;现改为明确说明「脚本已删,这些数字现在无法复现,只能当存档看」。②**§10 的"硬约束"用着 v1.x 的表名** —— 约束 1 写 `page_id`、§10.1 写 `page_contents.ydoc_snapshot`,而这两张表在 v2.0 已分别改名 `node_id` / `node_contents`。这一节开头写着"违反任何一条阶段二都要返工",名字指向不存在的表比措辞过时严重得多。③**§7.4 的 `pages.version`** 同理改为 `nodes.version`(理由那一段是现行的,只有表名是旧的)。④**`.env.example` 里两个"假开关"**:`POSTGRES_PORT` 与 `VITE_API_BASE` —— 声明了但**没有任何一处读**(postgres 不对宿主机暴露端口;前端把 `/api/v1` 写死在 `lib/api.ts`)。"填了不生效的开关"比"没有这个开关"更坏:有人会改了它然后等一个永远不来的效果。两处都改成了**说明为什么没有这个开关**,并给出正确的做法(`docker compose exec postgres psql`)。⑤**`APP_VERSION` 被代码读取却没声明** —— 它出现在 `/api/v1/health` 的响应里,运维靠它确认"跑的是哪一版镜像",现补进 `.env.example`。⑥**`/health` 与 `/health/ready` 没进接口清单** —— 它们是**唯一**不需要登录的非认证接口(探针不带凭证),`@Public()` 放行的理由值得写下来,现单列「运维探针」一张表并说明存活/就绪的分工(存活刻意不查依赖,否则数据库一挂容器会被反复重启)。⑦**§7.2 路由表缺 404 兜底行**,并补上「前五条不需要登录外壳、`/admin/*` 外面还包了一层只负责体验的 `RequireSuperAdmin`」这两句——判权始终在服务端。**把检查固化下来**:新增 `scripts/audit-docs.mjs` 接进 `pnpm check`,双向比对四件事 —— 接口(§6.2 表格 ↔ 控制器实际注册的路由,**文档多写与少写都报**)、环境变量(`process.env.X` ↔ `.env.example`,**两个方向都报**,包括"声明了没人读")、文件路径(文档提到的仓库路径是否真的存在)、版本号(文档头 = 变更记录最新一行)。两个刻意的设计:**双向比对**(只查一侧,另一侧会慢慢烂掉)、**例外必须写理由**(有意为之的进脚本里的名单,每条带一句话;没有理由的名单迟早会变成"把报错塞进去就完事"的地方,那时这个检查就死了)。**检查器自身的三个假漂移也一并修掉**:`PLANNED_ONLY` 用原始字符串导致 `WS /collab?nodeId=&token=` 匹配不上 `/collab`;搜索根目录漏了各 `src/` 导致 `lib/typography.ts`、`org/import.core.ts`、`audit/record.ts` 这类"从 src 写起"的引用全被判为不存在(一次报 6 个假漂移);占位符写法(`<包>`)被当成真路径。**并验证了它真的会失败** —— 往 `.env.example` 里塞一个假开关,退出码 1 且指名道姓;删掉后恢复通过(一个从不失败的检查等于没有检查)。另给 §9 的 M1~M6 清单补了一句"这是 v1.x 时代的执行记录,不是待办,未标注的条目里也有表名已改的"。 |
