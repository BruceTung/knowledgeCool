# 知源 KnowledgeCool · 设计说明书

| 项       | 值                                                                                      |
| -------- | --------------------------------------------------------------------------------------- |
| 文档版本 | v5.43                                                                                   |
| 状态     | **依据实际代码逐项核对后重写**。事实性表格由脚本生成并被门禁校验;手写的判断逐条指到文件 |
| 定位     | 内网自托管 · 按公司组织架构组织的企业知识库                                             |

---

## 0. 这份文档凭什么可信

### 0.1 事实由代码生成(四张表)

| 生成块         | 来源                                                    | 生成器                |
| -------------- | ------------------------------------------------------- | --------------------- |
| 接口清单(§6.2) | 各 `*.controller.ts` 的 `@Controller` 与 `@Get/@Post/…` | `scripts/gen-doc.mjs` |
| 数据模型(§4.2) | `apps/api/prisma/schema.prisma`                         | 同上                  |
| 环境变量(§9.1) | `apps/api/src/config/configuration.ts`                  | 同上                  |
| 前端路由(§7.1) | `apps/web/src/App.tsx`                                  | 同上                  |

这些表格包在 `<!-- BEGIN GENERATED:… -->` 与 `<!-- END GENERATED:… -->` 之间。
**手动编辑它们没有意义** —— `pnpm audit:docs` 会重新生成一遍并逐字比对,不一致就让门禁失败。

> ⚠️ 生成内容**外面还包着一层 `<!-- prettier-ignore-start/end -->`**,这不是装饰。
> 两份门禁对同一段文本的要求是**互相冲突**的:这里要它"逐字等于生成器的输出",
> 而 Prettier 会把 Markdown 表格的每一列补齐到等宽、并合并标题里的多余空格。
> 实测:跑一次 `prettier --write DESIGN.md` 之后 `gen-doc.mjs --check` 立刻失败
> (250 行落在生成块内)。用 Prettier 自己的区域忽略标记圈起来,两边才同时成立。
> 标记由生成器写出,所以"改了代码就跑 `node scripts/gen-doc.mjs`"不会把格式弄坏。

### 0.2 约束由机器检查

`pnpm audit:docs`(`scripts/audit-docs.mjs`)共十二项:

1. **接口**:§6.2 与控制器注册的路由**双向**比对(文档少的、多的都报)
2. **环境变量**:代码读的 ↔ `.env.example` 声明的,双向比对
3. **文件路径**:文档里提到的仓库路径必须真的存在
4. **版本号**:文档头版本 = 变更记录最新一行
5. **前端调用 ↔ 后端路由**:前端写的字符串路径必须都能在后端找到
6. **docker-compose ↔ 代码**:compose 传给 api 的环境变量必须是代码真读的
7. **弃用结构**:已删除的数据库列/索引不许再出现在源码里
8. **生成块**:§0.1 的四张表与代码一致
9. **章节引用**:文档与全部源码注释里的每一个 `§x.y` 都必须指得到真实的标题。
   ⚠️ 这一条是被旧文档的真实缺陷逼出来的:它把「§5.6」引用了 8 次,而那一节**根本不存在**。
10. **文档数量**:仓库里只允许有一篇 `*.md`。⚠️ 这条约定原本**没有任何机制** ——
    脚本里是 `read('DESIGN.md')` 硬编码,把 `DEPLOY.md` 加回来门禁一样绿。
11. **字号刻度**:前端源码里不许出现任意值字号(`text-[13px]` 之类)。
    ⚠️ 它原来由 `typography.test.ts` 执行;全部测试被删除后,规则还在而执行者没了,
    `MIN_FONT_PX` / `ALLOWED_ARBITRARY_PX` 一度成为没人读的死常量。
    **"文档说有门禁、而门禁不存在"比没有规则更坏**,所以这两条都补成了真检查。
12. **§9.1 的环境变量表必须覆盖代码真读的每个键**:要么自己有一行,要么在
    某一行的表达式里**真的被引用**(`process.env.X`)。
    ⚠️ 判据刻意不是"这个词出现过" —— 生成器会把源码行的**行尾注释**一并放进
    单元格,裸词匹配的话一句注释就能让缺失的行蒙混过关(对抗性复核实测过)。
    ⚠️ 前两项检查各自自洽却**从不交叉**:第 8 项比
    "生成物 ↔ 文档",第 2 项比"代码扫描 ↔ `.env.example`",而生成器每行只取
    第一个 `process.env.X` —— 于是与别的变量写在同一行的新变量会**静默不进文档**。

### 0.2.1 行为断言怎么办

上一条检的是**结构性事实**。文档里还有一类话是**从代码读出来、再写成人话**的,
比如「导出传错 `format` 回 400,而且参数校验先于权限校验」。这类句子机器比对不了 ——
唯一能验的办法是**真的打一次接口**。

`apps/api/scripts/verify-doc-claims.mjs` 对着一套跑起来的实例逐条打请求
(直接按脚本路径调用,它不是 `pnpm` 命令)。

端到端回归在 `pnpm verify:org`(`apps/api/scripts/verify-org.mjs`)。

> 所以这份文档里的每一句"会发生什么",要么指得到代码,要么被脚本打过。

### 0.3 其余内容是判断,不是事实

- **每条判断都要能指到代码**。指不到代码的判断,这里不写。
- **正文只写"现在是什么",不写"某版本曾经怎样"** —— 历史在 git 里。
  两处例外,都是刻意的:① 附录的**变更记录**(它本来就是时间线);
  ② 正文里少量「v2.12 起不再有回收站」这类**边界说明** —— 它们的作用是
  拦住"照着旧模型改代码"的人,不是在讲历史故事。
- **全仓库只留一篇文档**(就是这一篇),由 §0.2 的第 10 项检查强制。
  **显式例外只有两篇,都在 `scripts/audit-docs.mjs` 的 `EXTRA_DOCS` 里登记了理由**:
  ① `REMAINING.md` —— **临时的工作交接清单**(还剩什么没做),**做完即删**;
  破例放进仓库的原因是开发机是**网吧机器**,桌面与临时目录会被还原,
  放在仓库外第二天就没了。
  ② `OPTIMIZATION-BACKLOG-2026-10-03.md` —— 代码评审产出的优化项清单
  (P0/P1/P2),性质同 ①,**做完即删**(落地后并入 §11)。
  **想再加一篇,必须同样显式登记。**
  ⚠️ **"默认不允许"这条规则本身没有变** —— 默默多出一篇,门禁照样会红。
  ⚠️ **例外名单不是"报错收纳箱"**:每条都必须写清理由,没有理由的名单
  迟早变成"把报错塞进去就完事"的地方,那时这条检查就死了。

### 0.4 读这份文档时的约定

- 章节号(§5.4 这类)是**稳定标识**,代码注释里引用了它们,不要重排。
- 带 ⚠️ 的是**踩过的坑**,不是风格建议。
- 表格上方的"由 … 生成"不是装饰,是**这份内容的来源声明**。

---

## 1. 项目定位与范围

### 1.1 定位

内网自托管的**企业知识库**。与通用 SaaS 知识库的差别在于组织方式:
内容直接挂在**公司既有的组织结构**(部门 / 组 / 项目)下,而不是让用户自由创建"空间"。

|            | 通用 SaaS 知识库              | 本项目                                    |
| ---------- | ----------------------------- | ----------------------------------------- |
| 组织结构   | 用户自建空间,与公司架构无关联 | **就是公司的组织架构**(部门 / 组 / 项目)  |
| 谁建空间   | 任何用户                      | 只有组织内有权的人;空间对应真实的组织单元 |
| 默认可见性 | 常需逐空间授权                | **默认全员可读**;可按节点显式收紧(§5.6)   |
| 部署       | 公网 SaaS                     | 内网自托管,Docker Compose 四容器          |

### 1.2 已实现的能力(当前状态)

| #   | 能力       | 说明                                                                        | 实现位置                         |
| --- | ---------- | --------------------------------------------------------------------------- | -------------------------------- |
| 1   | 账号与登录 | 工号 + 密码;首次登录强制改密(§6.1.2);失败限流与锁定(§6.1.3)                 | `auth/`                          |
| 2   | 组织架构   | 部门 / 组 / 项目三级(技术上不限层数);Excel 增量导入;人员可多归属            | `org/`                           |
| 3   | 内容树     | 空间与页面是**同一种节点**;新建 / 改名 / 移动 / 拖拽排序;**删除即物理删除** | `node/`                          |
| 4   | 编辑器     | Tiptap;标题 / 列表 / 代码块 / 图片 / 表格 / 引用;链接气泡;乐观锁            | `web/features/content/`          |
| 5   | 权限       | 所有者 + 祖先链 + 显式授权;判权在服务端;缓存可降级(§5.5)                    | `permission/`                    |
| 6   | 保密       | 节点级 `visibility` + 独立读者名单;八条读取路径逐条收口(§5.6)               | `permission/`                    |
| 7   | 检索       | 中文可用(`ILIKE` + `pg_trgm`);按可见性过滤;命中高亮                         | `search/`                        |
| 8   | 评论       | 页面级讨论串,支持一层回复;**没有"已解决"状态**                              | `comment/`                       |
| 9   | 批量移动   | 最多 50 个;拒绝互为祖先的选法;全做或全不做(§8.5)                            | `node.service.bulkMove`          |
| 10  | 审计       | 全量记录;按动作筛选;导出 CSV(与列表同一可见范围)                            | `audit/`                         |
| 11  | 导出       | Markdown 导出;打印 / 存 PDF 走浏览器(§7.6)                                  | `content.service.exportMarkdown` |
| 12  | 个人视图   | 最近浏览 / 收藏 / 检索历史(**只存浏览器本地**)                              | `web/lib/personal-*.ts`          |

### 1.3 明确不做

实时多人协同 · 行内锚定评论 · 通知推送 · SSO / 企业微信登录 · 版本历史与差异对比 ·
语义问答 RAG · 模板中心 · 移动端适配 · 开放 API · 服务端生成 PDF · 回收站(删除不可逆)。

> **写在这里是为了防止开发中途被不断加需求。** 任何人想加需求,先改这一节。

---

## 2. 技术栈

### 2.1 选型

| 层     | 选型                     | 说明                                                                                                                          |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 语言   | TypeScript 6             | 前后端同语言,共享类型                                                                                                         |
| 后端   | NestJS 12                | 模块化 + 装饰器路由 + 依赖注入                                                                                                |
| ORM    | Prisma 7                 | 生成物在 `apps/api/src/generated/prisma`                                                                                      |
| 数据库 | PostgreSQL 16(`pg_trgm`) | 中文检索靠三元组,不靠分词器(§2.3)                                                                                             |
| 缓存   | Redis 7                  | 权限判定缓存、登录限流;**可降级依赖**(§3.2)                                                                                   |
| 前端   | React 18 + Vite          | TanStack Query(服务端状态)+ Zustand(客户端状态)                                                                               |
| 编辑器 | Tiptap 3                 | ProseMirror JSON 存储                                                                                                         |
| 样式   | Tailwind v4              | 字号刻度见 §7.3                                                                                                               |
| 验证   | 无单测框架               | 事实一致性靠 `pnpm audit:docs` 的十二项机器检查;行为靠 `pnpm verify:org` 与 `apps/api/scripts/verify-doc-claims.mjs` 打真接口 |
| 部署   | Docker Compose           | 四容器:postgres / redis / api / web                                                                                           |

### 2.2 版本约束(实测,不是"看起来新就行")

- **Node ≥ 22.12**。Prisma 7 要求 `^20.19 || ^22.12 || >=24`。镜像用 `node:22-alpine`。
- **pnpm 由 `corepack` 按 `packageManager` 字段拉取**。
- **构建顺序有依赖**:`packages/shared` 必须先 `build`,因为 api 与 web 通过 workspace
  链接引用它的 `dist/*.d.ts`。直接跑 `tsc` 会找不到类型 —— 这不是配置问题,是 monorepo 的固有顺序。

### 2.3 ⚠️ 中文检索:PostgreSQL 自带分词器不可用

实测结论:**`tsvector` 对中文命中率为 0**。`to_tsvector` 会把中文当作一个不可切分的词,
搜「空间」匹配不到「空间成员按职责划分」。

所以中文检索走 **`ILIKE` 子串 + `pg_trgm` 相似度**:

- 主排序键是**命中位置**(标题命中 2 分、正文命中 1 分),`similarity()` 只做同档内的次级排序。
- 为什么不用 `similarity()` 当主键:`trgm` 需要至少 3 个字符才有意义,
  中文搜两个字(「权限」「部署」)普遍得 0,排序会退化成不确定顺序。
- `LIKE` 的通配符必须转义(`escapeLike`)。不转的话搜 `100%` 会命中全部内容。

> 这是**方案级**的结论:想上中文全文检索,得换搜索引擎(§11.2),不是在 PG 里调参能解决的。

### 2.4 内网也必须上 HTTPS

会话 Cookie 是 `HttpOnly` 的,而内网同样存在同网段嗅探。
有域名就上 Let's Encrypt;没有域名、用 IP + http 访问时**必须显式设 `SESSION_COOKIE_SECURE=false`**,
否则浏览器不回传 Cookie —— 表现是「登录成功但刷新后回到登录页」。

---

## 3. 系统架构

### 3.1 部署形态(四容器)

```
浏览器 ──▶ web(nginx, 80)── /api/* 反向代理 ──▶ api(NestJS, 3000)──▶ postgres
                │                                        └──▶ redis
                └── /data/uploads(只读挂载,nginx 直接出图,不经过 Node)
```

| 容器       | 镜像                 | 职责                                                 |
| ---------- | -------------------- | ---------------------------------------------------- |
| `postgres` | `postgres:16-alpine` | 主库;`pg_trgm` 扩展                                  |
| `redis`    | `redis:7-alpine`     | 权限缓存、登录限流计数;开了 appendonly               |
| `api`      | 自行构建             | NestJS;**启动时先 `prisma migrate deploy` 再起服务** |
| `web`      | 自行构建             | 构建前端产物 + nginx 反代                            |

- **附件目录 `uploads` 由 api 与 web 共享**(web 只读)。
- **迁移随容器启动自动应用**,幂等。
- 运行阶段**不装 pnpm**:启动路径上不需要包管理器。

### 3.2 分层职责

| 层                        | 职责                                    | 不该做的事       |
| ------------------------- | --------------------------------------- | ---------------- |
| 控制器                    | 取参数、调服务、定 HTTP 形状            | 不写业务判断     |
| 服务                      | 业务规则与判权                          | 不碰 `req`/`res` |
| 纯函数(`packages/shared`) | **权限判定**、可见性过滤、CSV、路径计算 | 不碰数据库       |
| Prisma                    | 数据访问                                | 不写业务规则     |

> **权限判定刻意做成纯函数。** 它是「错了不会报错」的逻辑(表现为某人多看到一点东西),
> 这样才能被**独立地推理与复核**,而不必连着 Prisma 一起 mock。

**Redis 的位置:缓存,不是数据源。** 连接失败或取不到世代号时一律回源数据库 ——
见 `PermissionService.generationOf` 返回 `null` 的分支,与 `LoginThrottleService.run` 的降级。

---

## 4. 数据模型

### 4.1 设计要点

- **空间与页面是同一种东西**(`nodes` 一张表)。`kind` 只影响展示(图标 / 默认展开),
  **不影响任何权限判定** —— 不要在权限代码里对 `kind` 做分支。
- **树用物化路径**(`materialized_path`),不用递归 CTE。
  一次 `UPDATE … WHERE materialized_path LIKE '前缀%'` 就能移动整棵子树,而且**不可能漏掉某个后代**。
  代价:改父级要重写路径,所以移动是"写放大"的操作(§8.1)。
- **`depth` 冗余存了一份**。取值约定:**根 = 0,子 = 父 + 1**(见 `NodeService.create`)。
  树删除也依赖它分层(`deleteSubtree`)。
- **乐观锁用 `version`**。改内容的接口多数带 `version`,不匹配回 409。
  ⚠️ 哪些操作校验它、哪些不校验,写在 `schema.prisma` 的 `version` 字段注释里 —— 那里是唯一清单。
- **没有软删除**。删除是物理删除,整棵子树一次删掉(§8.2)。

### 4.2 表结构

<!-- BEGIN GENERATED:models -->
<!-- prettier-ignore-start -->
##### AuditLog  →  `audit_logs`

| 字段 | 类型 |
|---|---|
| `id` | `BigInt` |
| `actorId` | `String?` |
| `action` | `String` |
| `targetType` | `String` |
| `targetId` | `String` |
| `detail` | `Json` |
| `ip` | `String?` |
| `createdAt` | `DateTime` |
| `actor` | `User?` |

##### Comment  →  `comments`

| 字段 | 类型 |
|---|---|
| `id` | `String` |
| `nodeId` | `String` |
| `parentId` | `String?` |
| `userId` | `String` |
| `body` | `String` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |
| `node` | `Node` |
| `parent` | `Comment?` |
| `replies` | `Comment[]` |
| `user` | `User` |

##### Node  →  `nodes`

| 字段 | 类型 |
|---|---|
| `id` | `String` |
| `parentId` | `String?` |
| `kind` | `String` |
| `title` | `String` |
| `position` | `Int` |
| `materializedPath` | `String` |
| `depth` | `Int` |
| `ownerId` | `String` |
| `status` | `String` |
| `visibility` | `String` |
| `version` | `Int` |
| `createdBy` | `String` |
| `updatedBy` | `String?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |
| `parent` | `Node?` |
| `children` | `Node[]` |
| `owner` | `User` |
| `creator` | `User` |
| `updater` | `User?` |
| `content` | `NodeContent?` |
| `grants` | `NodeGrant[]` |
| `readers` | `NodeReader[]` |
| `assignments` | `OrgAssignment[]` |
| `comments` | `Comment[]` |

##### NodeContent  →  `node_contents`

| 字段 | 类型 |
|---|---|
| `nodeId` | `String` |
| `contentJson` | `Json` |
| `ydocSnapshot` | `Bytes?` |
| `textForSearch` | `String` |
| `updatedAt` | `DateTime` |
| `node` | `Node` |

##### NodeGrant  →  `node_grants`

| 字段 | 类型 |
|---|---|
| `nodeId` | `String` |
| `userId` | `String` |
| `grantedBy` | `String` |
| `createdAt` | `DateTime` |
| `node` | `Node` |
| `user` | `User` |
| `granter` | `User` |

##### NodeReader  →  `node_readers`

| 字段 | 类型 |
|---|---|
| `nodeId` | `String` |
| `userId` | `String` |
| `grantedBy` | `String` |
| `createdAt` | `DateTime` |
| `node` | `Node` |
| `user` | `User` |
| `granter` | `User` |

##### OrgAssignment  →  `org_assignments`

| 字段 | 类型 |
|---|---|
| `userId` | `String` |
| `nodeId` | `String` |
| `createdAt` | `DateTime` |
| `user` | `User` |
| `node` | `Node` |

##### Session  →  `sessions`

| 字段 | 类型 |
|---|---|
| `id` | `String` |
| `userId` | `String` |
| `expiresAt` | `DateTime` |
| `lastSeenAt` | `DateTime` |
| `userAgent` | `String?` |
| `ip` | `String?` |
| `createdAt` | `DateTime` |
| `user` | `User` |

##### User  →  `users`

| 字段 | 类型 |
|---|---|
| `id` | `String` |
| `employeeNo` | `String` |
| `name` | `String` |
| `passwordHash` | `String` |
| `mustChangePassword` | `Boolean` |
| `avatarColor` | `String` |
| `status` | `String` |
| `isSuperAdmin` | `Boolean` |
| `lastLoginAt` | `DateTime?` |
| `createdAt` | `DateTime` |
| `updatedAt` | `DateTime` |
| `ownedNodes` | `Node[]` |
| `createdNodes` | `Node[]` |
| `updatedNodes` | `Node[]` |
| `assignments` | `OrgAssignment[]` |
| `grantedGrants` | `NodeGrant[]` |
| `receivedGrants` | `NodeGrant[]` |
| `readableNodes` | `NodeReader[]` |
| `grantedReads` | `NodeReader[]` |
| `comments` | `Comment[]` |
| `auditLogs` | `AuditLog[]` |
| `sessions` | `Session[]` |

共 **9** 张表。由 `scripts/gen-doc.mjs` 从 `schema.prisma` 生成,`pnpm audit:docs` 校验一致性。
<!-- prettier-ignore-end -->
<!-- END GENERATED:models -->

### 4.3 几处反直觉的地方

- **`node_readers` 与 `node_grants` 是两张表**,不是一个"权限"表的两种取值。
  前者回答「谁能**读**」(保密),后者回答「谁能**改**」(授权)。口径不同、管理权限也不同(§5.6)。
- **`org_assignments` 允许一个人挂在多个节点上**(多归属)。
  「移出归属」不等于「收回权限」:被移出的组长仍然是组长(§8.6)。
- **`audit_logs.id` 是 `BigInt`**,JSON 装不下 64 位整数,所以对外一律按**字符串**往返。
  游标分页因此要显式校验(§6.4)。
- **`nodes.visibility` 是 `TEXT` + CHECK 约束**,不是 PG 枚举类型。
  用 `TEXT` 是为了加取值时不用 `ALTER TYPE`。
- **`node_contents.content_json` 是 JSONB**,同时存一份 `text_for_search` 纯文本。
  后者由纯函数从 ProseMirror 文档抽取,专供检索。
- **`nodes.parent_id` 是 `onDelete: Restrict`**,而 v2.12 起没有软删除。
  这条约束现在的实际作用是**逼应用层按"深度从叶子往根"逐层删**(`NodeService.deleteSubtree`):
  `DELETE` 不支持 `ORDER BY`,一条语句删整棵子树会撞外键。

---

## 5. 权限模型

### 5.1 三个概念

| 概念         | 含义                                        | 存在哪            |
| ------------ | ------------------------------------------- | ----------------- |
| **所有者**   | 节点的责任人。一级节点是"部长",二级是"组长" | `nodes.owner_id`  |
| **授权**     | 额外允许某人改这个节点                      | `node_grants`     |
| **组织归属** | 谁属于哪个组织单元(决定他能给谁授权)        | `org_assignments` |

判定写成 `packages/shared/src/permission.ts` 里的**纯函数**,与数据库无关,可以逐条读、逐条用接口验。

### 5.2 三条定稿规则

| 规则                                | 含义                                                                                     | 为什么                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **读默认开放**                      | 默认所有节点对所有登录用户可读;**显式设成「受限」的节点只有授权的人能看到**,整棵子树继承 | 知识库的价值在于共享。但总有例外(人事、薪酬、未定稿方案),所以给一条逐节点、显式、可审计的口子 |
| **编辑权沿祖先链继承,且不可被拒绝** | 上层所有者天然能改下层的一切;没有 deny                                                   | 管理链条上每一级都要能介入下属的内容。收回权限的唯一手段是**从授权名单里删行**                |
| **授权受组织范围约束**              | 操作者只能授权给**落在自己组织范围内**的人                                               | 防止横向越权:组长不该能把权限给到别的部门的人                                                 |

「组织范围」的定义:

```
orgScope(user) = 该用户所有 org_assignments 指向的节点及其全部后代
```

举例:组员 A 属于「后端组」。A 在组下建了子空间 S 且是 S 的所有者,因此 A 能给 S 授权;
但他的 `orgScope` 只有「后端组」这一支,所以**只能授权给后端组里的人**。
部长的 `orgScope` 是整个技术部。**范围自下而上自然放大,不需要单独维护「谁的权限更大」。**

实现:`PermissionService.isInOperatorScope` + 纯函数 `isWithinSubtree`
(前缀判断**必须带尾斜杠**,否则 `/p-1` 会被误判为 `/p-10` 的祖先)。

### 5.3 能力对照

| 动作                                                | 谁能做                                                             | 判定函数                      |
| --------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| 浏览任意节点                                        | 所有登录用户(受限节点除外,见 §5.6)                                 | `canRead`                     |
| 发表 / 回复评论                                     | 能读该节点的登录用户                                               | `requireRead`                 |
| 删除评论 / 改评论                                   | 见 §5.4                                                            | —                             |
| 在节点下新建                                        | 在该节点上 `canEdit` 的人;**组员可在自己所属的节点及其上级下新建** | `canCreateUnder`              |
| 编辑正文 / 改标题 / 移动 / 同级排序                 | `canEdit`                                                          | `canEdit`                     |
| **删除节点**(物理删除,不可恢复)                     | **祖先链所有者**                                                   | `canManage`                   |
| 授权 / 收回(增删名单)                               | `canManage`,且被授权者须在操作者组织范围内                         | `canGrantTo`                  |
| 管理可见范围(读者名单)                              | **该节点的创建者,或所有者链上任一节点的人(含上级所有者)**          | `canManageReaders`            |
| 任命 / 变更二级节点的所有者                         | 该节点的祖先所有者(即部长);一级节点只有超管                        | `OrgService.setOwner`         |
| 维护组织架构(建部门 / 导人员 / 设归属 / 看组织范围) | `is_super_admin`                                                   | `requireSuperAdmin`           |
| 查看审计日志                                        | 祖先链所有者,或 `is_super_admin`                                   | `AuditService.visibleNodeIds` |

> ⚠️ **删除的门槛高于编辑。** 被授权者能改、能建,但不能**销毁**;
> 删除已经是不可逆操作,所以它归所有者(`NodeService.remove`)。
>
> ⚠️ **读者名单的门槛里包含「上级所有者」,这是刻意的,不是漏写。**
> 它意味着**上级所有者可以把自己加进下级的保密节点**,从而读到它。
> 两条理由:
>
> 1. 所有者是这个节点的**内容责任人**;少了这条,创建者一旦离职或调岗,
>    那个节点的名单就**永久冻结** —— 再也加不进人,也移不出人。
> 2. 本模型的取向是「**越靠上权限越大**」(§5.2)。上级能看下级的受限节点,
>    与"上级能改、能删下级的节点"是同一件事的三种表现。
>
> **保密真正挡的是平级与下级**:他们既不在读者名单里,也不在所有者链上,
> 判定出来的结果直接是 404(§5.6)。所以"设成受限"要防的对象,从一开始就不是上级。
> (旧版这一格曾写作"上级所有者**不能**代为管理" —— 那句话与代码相反,已更正。)

### 5.4 评论的权限边界

| 动作        | 门槛                                                         | 实现                                  |
| ----------- | ------------------------------------------------------------ | ------------------------------------- |
| 看评论      | 能读这个节点                                                 | `CommentService.list` → `requireRead` |
| 发表 / 回复 | 能读这个节点(**全员**);回复只允许一层,且必须挂在同一个节点下 | `CommentService.create`               |
| 改评论正文  | **只有作者本人**(所有者也不行)                               | `CommentService.update`               |
| 删除        | 作者本人,或该节点的 `canManage`                              | `CommentService.remove`               |

⚠️ 服务端返回的 `canEdit` 与 `canDelete` **是两个字段**:所有者能删别人的评论,
但**不能改**(篡改他人言论)。两者曾经共用一个标志位,表现是「所有者看得到编辑按钮、点了却 403」。

⚠️ **评论就是评论,不是"问题单"(v2.4)。** 没有 `open`/`resolved` 状态,没有「标记已解决」,
角标显示的是**评论总数**且是中性灰。那套语义已连同数据库列一起删除,**不要加回来**。

### 5.5 权限缓存与失效

判定结果缓存在 Redis,key 是 `kc:perm:{世代号}:{userId}:{nodeId}`,TTL **30 秒**。

**失效用世代号,不用 `SCAN` 批量删。** `SCAN` 既慢,而且**可能漏**
(遍历期间写入的 key 不在已扫过的桶里,会一直活到 TTL)——
漏的表现是「权限已经改了,但某个人还能改」,**静默越权**。

⚠️ 世代号在 `access()` 里**只读一次**,并且这一个值贯穿"读缓存"与"写缓存"两端。
若在写缓存时再读一次,compute() 期间恰好有 INCR 落进来时,会把"失效之前算出来的结果"
写进**新世代**,于是它躲过这次失效并存活满 30 秒。

世代号按**一级节点(部门)**分片(`kc:perm:gen:{rootId}`)。
组织归属变更会影响多个部门,那类操作调用 `invalidateAllGenerations()`。

### 5.6 保密:受限节点与读取路径

**`nodes.visibility` 只有两个取值:`public`(默认)/ `restricted`。**

判定规则(纯函数 `canRead` / `readableNodeIds`):

1. 链上(自身 + 全部祖先)**没有 restricted** → 可读。这是绝大多数节点。
2. 链上有 restricted → 那些受限节点**每一个**都必须放行,整条链才可读。
   放行的四条路(满足任一):
   a. 我是它**或它某个祖先**的所有者(越靠上权限越大,与 `canEdit` 同一方向);
   b. 我是它的**创建者**;
   c. 我在它的**读者名单**里;
   d. 我本来就是它的**编辑被授权者**。

**三条刻意的决定:**

- ⚠️ **必须逐个受限节点都放行,不能只看最近的那个。** 只看最近的话,
  「外层受限节点里再放一个更内层的受限节点」时,只在**外层**名单里的人会读到内层 —— 那是泄露。
- ⚠️ **创建者放行。** 否则会出现两件坏事:① 能管一个自己看不见的东西的名单;
  ② **永久把自己锁在外面** —— 设成受限且名单为空之后他读不到(404),
  也就再也调不动那个管理入口。真机上曾这样锁住过,只能进数据库救。
- ⚠️ **编辑被授权者也放行。** 否则会出现「能改但不能看」:
  他打开文档就是空白,只会被当成 bug 报上来。

**读取路径必须逐条收口。** 漏掉任何一条,受限文档的内容就会从那条路漏出去,
而其余路径看起来完全正常。当前**全部**读取路径:

| #   | 路径                  | 实现                                                                               | 读不到时           |
| --- | --------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| 1   | 组织与内容树          | `NodeService.tree`(内存里过 `readableNodeIds`)                                     | 节点不出现在结果里 |
| 2   | 节点详情              | `NodeService.detail`                                                               | **404**            |
| 3   | 节点正文              | `ContentService.get`                                                               | **404**            |
| 4   | 导出 Markdown         | `ContentService.exportMarkdown`                                                    | **404**            |
| 5   | 评论列表 / 发表       | `CommentService.list` / `create`                                                   | **404**            |
| 6   | 检索                  | `SearchService.search`(逐条 `access().canRead`)                                    | 命中被丢掉         |
| 7   | 读者名单 / 授权视图   | `readersOverview` / `overview`                                                     | **404**            |
| 8   | 各类候选人 / 成员列表 | `candidates`、`readerCandidates`、`memberCandidates`、`ownerCandidates`、`members` | **404**            |

⚠️ **回 404 而不是 403**(读路径)。403 等于确认「这里有个你看不见的东西」,
而保密的意义就在于不确认它的存在。**写路径**上被拒才回 403(你看得见它,只是改不了)。

⚠️ **"一致性本身就是安全性质"。** 一条不一致的路径就是一条侧信道 ——
只挡住详情而漏掉检索或成员列表,攻击者就能靠"哪个接口回 200"反过来推出节点存在。
这类漏口历史上补过多次(`readersOverview`、`members`,以及第 8 行那一组候选人接口)。
**新增任何读取路径时,把它加进这张表,并在 `verify-org` 里加一条侧信道断言。**

⚠️ **限制是继承的,而且只能往上改。** 一个节点显示"受限"时,限制可能来自某个祖先;
在它自己这一层改回公开**不会生效**。接口因此返回 `inheritedFrom`(`readersOverview`),
界面上明说这一点(`VisibilityDialog`)。

⚠️ **受限 ≠ 只有名单里的人能看。** 所有者链与编辑被授权者本来就看得见 ——
名单是**追加**的,不是全集。

---

## 6. 接口

### 6.1 通用约定

- 前缀 `/api/v1`(`API_PREFIX`),全部返回 JSON。
- 认证:HttpOnly Cookie 承载**不透明会话 id**(`kc_session`),不用 localStorage 存 token。
- 错误体统一:

```json
{ "error": { "code": "FORBIDDEN", "message": "你没有编辑该节点的权限" } }
```

| 错误码              | HTTP | 含义                                         |
| ------------------- | ---- | -------------------------------------------- |
| `UNAUTHORIZED`      | 401  | 未登录或会话过期                             |
| `FORBIDDEN`         | 403  | 已登录,但对这个资源没有该操作的权限          |
| `NOT_FOUND`         | 404  | 资源不存在,**或读不到**(见 §5.6)             |
| `VALIDATION_FAILED` | 400  | 参数校验失败                                 |
| `VERSION_CONFLICT`  | 409  | 乐观锁冲突 / 并发序列化冲突,客户端需重新拉取 |
| `RATE_LIMITED`      | 429  | 触发限流(§6.1.3)                             |
| `INTERNAL_ERROR`    | 500  | 服务端未预期的错误;细节只写日志,不进响应体   |

> ⚠️ 这张表就是 `packages/shared/src/errors.ts` 的 `ERROR_CODES` —— **一一对应,不多不少**。
> 曾经还有一个 `PASSWORD_CHANGE_REQUIRED`:v2.2 的首次登录会先发会话、再由守卫拦成
> 「403 请先改密」。v2.4 改成首登**根本不建立会话**之后,未改密的人对业务接口
> 而言就是未登录(**401**),那个码再没有任何生产者,已删除。

- **请求体上限 8MB**(`app-setup.ts` 的 `BODY_LIMIT`)。
- body-parser 的解析错误**不是** `HttpException` 的子类,异常过滤器必须显式识别,
  否则「请求体过大」会变成 500 —— 而它明明是客户端的问题。
- **分页:只有审计日志与人员列表用游标分页。**
  审计返回 `{ items, nextCursor }`;人员列表返回 `{ users, total, nextCursor }`。
  ⚠️ **评论不分页** —— `CommentListResponse` 只有 `{ nodeId, total, threads }`,
  服务端把该节点的评论一次全查出来(`CommentService.list`,没有 `take`/`skip`)。
  这是**已知的欠账**,不是设计(见 §11.3):它与其他"必须有上限"的地方
  (审计 50 条/页、批量移动 50 个、检索 20 条)不一致。

### 6.1.1 会话机制

- 会话 id 是**不透明随机串**,服务端存 **SHA-256 哈希**(`sessions.id` 是 `CHAR(64)`),库里没有明文。
- Cookie 属性:`HttpOnly` + `SameSite=Lax` + `Secure`(由 `SESSION_COOKIE_SECURE` 控制)。
- 默认有效期 720 小时(`SESSION_TTL_HOURS`)。
- **守卫每次请求都查一次 `users.status`**,所以停用/离职能立刻生效;
  改状态时还会主动删掉该用户的全部会话行(§9.3)。
- 守卫还有一条**纵深防御**:遇到"有会话但 `must_change_password` 仍为真"的异常状态时,
  直接吊销该会话并按未登录处理(`AuthGuard`)。

### 6.1.2 密码策略与首次登录改密

- 密码用 **bcrypt,cost 12**;强度要求 ≥ 8 位且同时含字母与数字(`checkPasswordStrength`)。
- 初始密码统一 `123456`(`INITIAL_PASSWORD`),新账号一律带 `must_change_password=true`。

**首次登录不建立会话。** 这是刻意的:

```
POST /auth/login        → 若 must_change_password:返回 password-change-required + 一次性凭证
                          **不下发会话 Cookie**
POST /auth/initial-password(凭一次性凭证)→ 改密成功,仍然不下发会话
POST /auth/login        → 用新密码登录,这次才下发会话
```

> 为什么这么绕:如果首次登录就发会话,那么"还没改密的人"就是一个可被利用的中间态 ——
> 他能用一个全公司统一的初始密码访问系统。现在这个状态**在服务端根本不存在**(没有会话)。

一次性凭证(`setupToken`):

- 内容含用户 id、过期时间,**用 `SESSION_SECRET` 做 HMAC 签名**;校验用 `timingSafeEqual`。
- **`SESSION_SECRET` 没有默认值**,部署时必须显式配置;为空时首登改密**不降级放行**,
  而是明确报错(`requireSessionSecret`)。
- 校验三道:签名有效且未过期、用户**仍然**处于待改密状态、新密码过强度校验。
- ⚠️ 已知风险(写在这里,不藏):凭证是**无状态**的,改密成功后服务端不记录"已用过"。
  它只在"未改密"这个极短窗口内有意义,且需要先拿到密码。

### 6.1.3 登录限流与锁定

**两道门,按账号与按 IP 分别计数。**

| 维度    | 计数键                   | 阈值                            | 窗口 / 锁定时长                    |
| ------- | ------------------------ | ------------------------------- | ---------------------------------- |
| 账号    | `kc:login:fail:u:{工号}` | 5 次(`LOGIN_MAX_ATTEMPTS`)      | 15 分钟(`LOGIN_LOCK_MINUTES`)      |
| 出口 IP | `kc:login:fail:ip:{ip}`  | 100 次(`LOGIN_IP_MAX_FAILURES`) | 15 分钟(`LOGIN_IP_WINDOW_MINUTES`) |

锁定期间**不校验密码**。被锁时返回 `RATE_LIMITED`(429),错误体带 `retryAfterSeconds`。

**四条刻意的设计:**

1. **限流检查放在 bcrypt 之前。**
2. **锁定键按「工号」计数,包括不存在的工号** —— 否则"被锁定"就成了账号枚举器。
3. **IP 那道门只统计失败,且成功不清 IP 计数**;账号那道门在登录成功时会清零。
4. **计数只在第一次失败时设过期** —— 每次都续期会让计数永不过期。

⚠️ **Redis 挂了会怎样:锁定失效(退回无限尝试),系统其他部分照常。**
这是刻意的取舍 —— 限流是"防爆破"的加固,不是"身份正确性"的一部分。

**审计:** 只有**真实存在**的账号被锁时才写 `auth.login.locked`。

**出口 IP 从哪来:** 取自 `request.ip`。生产拓扑是 `浏览器 → Nginx → api`,
所以 `app-setup.ts` 显式设了 `trust proxy = 1` —— Express 默认**不读**
`X-Forwarded-For`,不设这一项时 `request.ip` 会**恒为 Nginx 容器的地址**。
那会让上面那道 IP 门退化成"全公司共用一个计数桶"(累计 100 次之后所有人一起被锁),
并且让审计与 `sessions` 里的 IP 全部失去意义。

> 信任 **1 跳**而不是 `true`:后者表示信任整条链,于是客户端只要自带一个
> `X-Forwarded-For: 1.2.3.4` 就能伪造来源、绕过限流。前端一跳 Nginx 用
> `$proxy_add_x_forwarded_for`,会把真实地址**追加**在末尾,所以取 1 跳既准确又不可伪造。
> 拓扑前提是 **api 服务不 publish 端口**(见 `docker-compose.yml`)。
>
> ⚠️ **"不可伪造"只在那个前提下成立。** 若请求能直达 api 端口(例如 `pnpm dev`
> 裸跑 3000),TCP 对端就是调用方自己,他自带的 `X-Forwarded-For` 会落在真实地址
> **左侧**,而"信任 1 跳"取的正是它 —— 也就是**调用方可以自选出口 IP**,
> 这道 IP 门在开发形态下形同虚设。所以:**生产必须保持 api 不 publish 端口**;
> 开发时别指望它挡人(按账号锁与 bcrypt 时序对齐不受这条影响)。

### 6.2 接口清单

<!-- BEGIN GENERATED:routes -->
<!-- prettier-ignore-start -->
| 方法 | 路径 | 实现 |
|---|---|---|
| GET | `/admin/org/import-template` | `org/org.controller.ts` |
| POST | `/admin/org/import` | `org/org.controller.ts` |
| PATCH | `/admin/users/:userId/assignments` | `org/org.controller.ts` |
| POST | `/admin/users/:userId/reset-password` | `org/org.controller.ts` |
| PATCH | `/admin/users/:userId` | `org/org.controller.ts` |
| GET | `/admin/users` | `org/org.controller.ts` |
| POST | `/admin/users` | `org/org.controller.ts` |
| GET | `/audit-logs/export` | `audit/audit.controller.ts` |
| GET | `/audit-logs` | `audit/audit.controller.ts` |
| POST | `/auth/change-password` | `auth/auth.controller.ts` |
| POST | `/auth/initial-password` | `auth/auth.controller.ts` |
| POST | `/auth/login` | `auth/auth.controller.ts` |
| POST | `/auth/logout` | `auth/auth.controller.ts` |
| GET | `/auth/me` | `auth/auth.controller.ts` |
| GET | `/auth/setup-state` | `auth/auth.controller.ts` |
| POST | `/auth/setup` | `auth/auth.controller.ts` |
| DELETE | `/comments/:commentId` | `comment/comment.controller.ts` |
| PATCH | `/comments/:commentId` | `comment/comment.controller.ts` |
| GET | `/health/ready` | `health/health.controller.ts` |
| GET | `/health` | `health/health.controller.ts` |
| GET | `/nodes/:nodeId/comments` | `comment/comment.controller.ts` |
| POST | `/nodes/:nodeId/comments` | `comment/comment.controller.ts` |
| GET | `/nodes/:nodeId/content` | `node/node.controller.ts` |
| POST | `/nodes/:nodeId/content` | `node/node.controller.ts` |
| PUT | `/nodes/:nodeId/content` | `node/node.controller.ts` |
| GET | `/nodes/:nodeId/export` | `node/node.controller.ts` |
| GET | `/nodes/:nodeId/grant-candidates` | `permission/permission.controller.ts` |
| GET | `/nodes/:nodeId/grants` | `permission/permission.controller.ts` |
| PUT | `/nodes/:nodeId/grants` | `permission/permission.controller.ts` |
| GET | `/nodes/:nodeId/member-candidates` | `org/org.controller.ts` |
| DELETE | `/nodes/:nodeId/members/:userId` | `org/org.controller.ts` |
| GET | `/nodes/:nodeId/members` | `org/org.controller.ts` |
| POST | `/nodes/:nodeId/members` | `org/org.controller.ts` |
| POST | `/nodes/:nodeId/move` | `node/node.controller.ts` |
| GET | `/nodes/:nodeId/owner-candidates` | `org/org.controller.ts` |
| PATCH | `/nodes/:nodeId/owner` | `org/org.controller.ts` |
| GET | `/nodes/:nodeId/reader-candidates` | `permission/permission.controller.ts` |
| GET | `/nodes/:nodeId/readers` | `permission/permission.controller.ts` |
| PUT | `/nodes/:nodeId/readers` | `permission/permission.controller.ts` |
| DELETE | `/nodes/:nodeId` | `node/node.controller.ts` |
| GET | `/nodes/:nodeId` | `node/node.controller.ts` |
| PATCH | `/nodes/:nodeId` | `node/node.controller.ts` |
| POST | `/nodes/bulk/move` | `node/node.controller.ts` |
| POST | `/nodes` | `node/node.controller.ts` |
| POST | `/org/nodes` | `org/org.controller.ts` |
| GET | `/org/scopes` | `org/org.controller.ts` |
| GET | `/org/tree` | `node/node.controller.ts` |
| GET | `/search` | `search/search.controller.ts` |
| POST | `/uploads` | `upload/upload.controller.ts` |

共 **49** 条。前缀 `/api/v1` 由 `app-setup.ts` 统一加;本表由 `scripts/gen-doc.mjs` 从控制器生成,`pnpm audit:docs` 会校验它是否与代码一致。
<!-- prettier-ignore-end -->
<!-- END GENERATED:routes -->

### 6.3 几个容易看错的细节

- **`GET /nodes/:id/export` 只能传 `?format=md`**(合法取值只有 `md`,`EXPORT_FORMATS`)。
  ⚠️ 这个参数**可以省略**,省略时按 `md` 处理;传别的值回 400,
  而且**参数校验先于权限校验**。
- **`POST /nodes/bulk/move` 的路径写作 `nodes/bulk/move`**,而且**注册在 `nodes/:nodeId/...` 之前**。
  Express 按注册顺序匹配,否则 `bulk` 会被当成一个 nodeId、被 `ParseUUIDPipe` 以 400 拒掉。
- **正文保存有 PUT 与 POST 两个入口**。POST 那条**只为 `navigator.sendBeacon` 存在** ——
  它只能发 POST。两个入口走同一个 service 方法,行为完全一致。
- **`GET /audit-logs/export` 返回 `text/csv`**,不是 JSON;文件名走 RFC 5987 编码;带 UTF-8 BOM。
  ⚠️ **导出有 5000 行上限**(`AUDIT_EXPORT_MAX_ROWS`)—— 审计表只增不减,
  不限就是一次全表扫描加一个几百 MB 的响应。超限**不是静默截断**:
  响应带 `X-Audit-Exported`(实际导出条数)与 `X-Audit-Capped`(是否被截断)两个头,
  用户能知道"这不是全部"。用响应头而不是正文,是因为正文必须是纯 CSV。
- **`DELETE /nodes/:id` 是物理删除**,删除整棵子树,不可恢复(§8.2)。
- **`GET /health` 不碰外部依赖**,**`GET /health/ready` 才会**检查数据库与 Redis。
  ⚠️ 两条的**真实路径**带全局前缀,即 `/api/v1/health` 与 `/api/v1/health/ready`
  (§6.2 的表格为了让"文档 / 控制器 / 前端"三方在同一坐标里比对而统一省掉了前缀;
  在这里按真实路径写,是因为这里讲的是**外部探针该打哪个地址**,省掉前缀会直接误导运维)。
  实测:`curl localhost:8080/health/ready` 走的是 SPA 回退,返回的是 `index.html`,
  **HTTP 200 但根本不是探针响应** —— 只看状态码会以为服务正常。
- **`GET /org/scopes` 是超管专属**。它返回组织架构全貌(含每个部门的人数),
  而组织架构归超管维护;按可见性过滤会造出一份"缺了几行"的架构图。

### 6.4 审计游标为什么必须校验

游标对外是**字符串**(审计主键是 `BigInt`,JSON 装不下 64 位整数)。
`normalizeCursor` 只接受 `^[0-9]{1,19}$`(19 位是 signed 64-bit 的十进制上限),其余一律 400。
不校验的话,`?cursor=abc` 会让 PostgreSQL 抛 22P02,再被全局过滤器兜成 **500 INTERNAL_ERROR**。

---

## 7. 前端

### 7.1 路由与页面

<!-- BEGIN GENERATED:pages -->
<!-- prettier-ignore-start -->
| 路径 | 组件 |
|---|---|
| `/setup` | `SetupPage` |
| `/login` | `LoginPage` |
| `/change-password` | `ChangePasswordPage` |
| `/` | `HomePage` |
| `/n/:nodeId` | `NodeDetailPage` |
| `/search` | `SearchPage` |
| `/audit` | `AuditPage` |
| `/admin` | `RequireSuperAdmin` |
| `/admin/org` | `OrgAdminPage` |
| `/admin/users` | `UsersAdminPage` |
| `*` | `NotFound` |

共 **11** 条。由 `scripts/gen-doc.mjs` 从 `App.tsx` 生成。
<!-- prettier-ignore-end -->
<!-- END GENERATED:pages -->

除 `/setup`、`/login`、`/change-password` 外,其余页面都在 `AppLayout` 里(顶栏 + 左树 + 主区)。
`/admin/*` 外面包了一层 `RequireSuperAdmin` —— 它**只负责体验**,判权始终在服务端。

左侧是**完整的组织与内容树**(由服务端过滤可见性后),主区是编辑器,右侧是上下文面板(目录 · 评论)。

### 7.2 状态管理

- **服务端状态**:TanStack Query。⚠️ 树的 `editableNodeIds` 是服务端算的,
  所以**改完必须失效重取**,不要在本地推导。
- **客户端状态**:Zustand。
- **个人视图**(最近浏览 / 收藏 / 检索历史)**只存 localStorage**,刻意不落库。
  ⚠️ 读写两侧都包了 `try/catch`:无痕模式/策略禁止时 localStorage 会直接抛。
  ⚠️ **展示前要按组织树过滤**:节点可能已被删除,也可能被设成受限而当前用户不在名单里 ——
  直接渲染本地列表就会把一个他已经无权看见的标题摆在他面前(`HomePage` 的 `visibleIds`)。

### 7.3 字号与排版刻度

五档,与 Tailwind 具名档一一对应,**不允许任何任意值字号**:

| 用途                                              | 字号     | Tailwind             |
| ------------------------------------------------- | -------- | -------------------- |
| 正文                                              | 16px     | `text-base`          |
| 标题                                              | 24px     | `text-2xl`           |
| **导航:组织树的行**                               | **16px** | `text-base`(`T_NAV`) |
| 界面文字:按钮 / 字段标签 / 面包屑 / 评论 / 搜索框 | 14px     | `text-sm`            |
| 辅助说明 / 计数 / 快捷键提示(下限)                | 12px     | `text-xs`            |

**12px 是下限。** 另外两条下限:**点击目标 ≥ 24px**;**对比度 ≥ 4.5:1**(WCAG AA)。

⚠️ **「导航」这一档是 v4.2 加的**(用户第四次说"太小"之后)。
它的理由不是"再大一点好看",而是**判据用错了**:

- ADS 把 14px 定为"**组件**里的默认档",针对的是按钮 / 表单 / tab 这类**局部**控件;
  而组织树是整页左侧的**主导航**,用户一天要点几十次,还要在同一列里比较
  "哪个是组、哪个是页面"。Confluence / Notion / VS Code 的文件树
  **都比正文按钮大一档**。
- 16px 与文档正文同档,于是"左树挑一篇 → 右边读它"两处字号一致,
  视线来回切换不用重新适应。
- 行高必须**一起**放大(36 → 44px)。只放大字号不放开行高,汉字会挤在一起,
  反而更难读。

### 7.3.1 科技感外壳(顶栏 + 左树)

用户反馈的原话是这两处"太小",并要"更直观一点、科技风高一点"。做法是把
**框架做成深色"控制台"面板**(CSS 类 `.kc-chrome`,见 `styles.css`),而**正文区保持浅色**。

这个分工是刻意的,不是审美偏好:

- 深色**只用在导航与外壳**上。正文是拿来读长文的,深底浅字在长文上容易疲劳,
  而且打印、截图、投到会议室屏幕上都不好。
- 框架深、画布浅,视觉上天然把「我在哪」和「我在读什么」分开 ——
  这正是用户要的"更直观"。

⚠️ **深底上的对比度是量出来的,不是估的。** 方法:把全部文字设为透明后截图,
这样文字位置只剩真实背景(含网格与光晕),再在文字矩形内取 35 个点、
按**对比度最低**的那个计。实测:树行 10.15:1、面板标题 8.77:1、用户姓名 16.68:1、
工号 6.48:1、按钮 8.50:1 —— 最低的也高于 4.5:1。

⚠️ 两个容易踩的坑(都真踩过):

1. **不要把 `.kc-prose` 那样"顺手也写一条 `white-space`"** 之类的冗余规则带进来 ——
   深色是**成组**的(底色 + 网格 + 光晕 + 边框 + 文字色),零散地写十几处
   `bg-[#...]` 会让"改一个配色要翻四个文件"。
2. **不要靠把左树加宽来解决字号变大后的截断。** 试过 288/320 → 384px,
   结果 1440px 的窗口下正文列从 806 掉到 720,编辑器工具栏**折成两行** ——
   而"工具栏折行"用户在 v2.8 已经提过一次。现在宽度**保持 320px**:
   宁可让个别长标题多截一点,也不把工具栏挤折。

### 7.4 编辑器

Tiptap 3,内容以 **ProseMirror JSON** 存库(`node_contents.content_json`)。

- **工具栏**:标题、列表、代码块(带语言高亮)、图片、表格(行列增删)、引用、链接气泡。
- **图片**:每页最多 **10 个**(`MAX_IMAGES_PER_NODE`,服务端强制),工具栏显示剩余额度。
- **乐观锁**:保存时带 `baseUpdatedAt`;服务端发现已被别人改过就回 409。
  ⚠️ 无法解析的 `baseUpdatedAt` 按校验错误处理,而不是"当成没传"。
- ⚠️ **`StarterKit` 的 `codeBlock` 必须关掉**,否则与 `CodeBlockLowlight` 是同一个节点
  的两份实现,表现是语言属性存不住。
- ⚠️ 工具栏激活态要订阅 `onSelectionUpdate`,只靠 `onUpdate` 会滞后。
- ⚠️ **链接气泡遇到站内路径 `/n/…` 与 `#锚点` 绝不能补 `https://`** ——
  那会把"跳到另一篇文档"悄悄改成"跳到外网站点",而且不报错。

#### 7.4.1 Tab 键

**在正文里按 Tab 是插入制表符,不是把焦点移出编辑器。**

⚠️ 默认行为并非"某处配错了",而是 **ProseMirror 不接管 Tab**,浏览器就按无障碍
规范把焦点移到下一个可聚焦元素(工具栏按钮、右栏目录项……)。全仓库唯一接管它的
是表格扩展,而它不在表格里时**明确返回 `false`** —— 于是正文里按 Tab,光标跳到
工具栏上,输入当场中断。它在 read-only 页面上倒是无害的,所以那条没暴露出来。

四条规则(实现在 `apps/web/src/features/content/editor/tab-keymap.ts`):

| 光标在哪        | Tab                          | Shift+Tab                 |
| --------------- | ---------------------------- | ------------------------- |
| 只读页面        | **不接管**(焦点照常走)       | 同左                      |
| 表格            | 移到下一格 / 末格补一行      | 移到上一格                |
| 列表项          | 降一级(嵌套到上一个兄弟下面) | 升一级                    |
| 代码块          | 插入制表符                   | 删掉行首一个缩进          |
| 普通段落 / 标题 | 插入制表符                   | 什么都不做,但**吞掉按键** |

两条刻意的决定:

- ⚠️ **列表里是"缩进"而不是"插入制表符"。** 往列表项的**文字里**塞一个制表符
  没有任何意义(它看起来什么都不像),而"Tab 把当前项降一级"是 Word / Google Docs /
  Confluence / Notion 的统一约定。降不了级时保持原位,但**仍然吞掉按键** ——
  焦点莫名其妙跳走比"没反应"更糟。
- ⚠️ **表格那条必须显式让路。** Tiptap **不会**把所有扩展的快捷键并成一张表:
  每个扩展各自拥有一个 keymap 插件。所以"处理器返回 `false`"会自然落到表格的
  处理器上,与扩展在数组里的先后无关;若在这里自己再实现一次 `goToNextCell`,
  就等于把表格的移动逻辑抄成第二份。

⚠️ **制表符要看得见,而且宽度要统一。** 两件事的来源不同(都经真实浏览器实测):

- **能不能显示**,取决于 `white-space` 是否保留空白 —— 而这一条
  **ProseMirror 自己已经管了**:它的样式表里写着
  `.ProseMirror { white-space: break-spaces }`(由 Tiptap 引入)。
  ⚠️ 所以**不要在 `.kc-prose` 里再写 `white-space`**:两者选择器优先级相同
  (都是单类),而它在样式表里**排在后面** —— 实测计算值就是 `break-spaces`,
  自己写的那条**从未生效**。写上去只会让人以为制表符可见是靠它。
- **多宽**,由 `styles.css` 的 `.kc-prose { tab-size: 4 }` 决定,ProseMirror 不管它,
  而浏览器默认是 **8**。那个 **4 必须与 `tab-keymap.ts` 的 `TAB_SIZE` 相同**:
  不一致的表现是 Tab 插入的宽度与 Shift+Tab 退掉的宽度对不上,
  "退一格退不干净,得按两下"。

### 7.5 保存与数据安全

⚠️ **这一节记录一个真实的 P0 事故,以及它后来暴露的第二半。**

编辑器曾经只在"点保存"和"定时器触发"时写库。实测:在文档里输入后 **250ms** 内切走页面,
**零个写请求发出** —— 输入的内容直接没了。

现在三条路都兜住:

1. **组件卸载时保存**(`useEffect` 的清理函数里真的发请求)。
2. **`beforeunload`** 时用 `navigator.sendBeacon` 发一次,并给出离开确认提示。
3. 常规的防抖保存(`AUTOSAVE_DELAY_MS = 1200`)。

⚠️ **第四条,后来才补上的:登出前冲刷**(`v5.43` 更正此节的措辞)。
上面三条都管不住登出 —— 它是**程序化导航**,不走 `beforeunload`。
实测的失效顺序是:先发 `POST /auth/logout` → 服务端**当场吊销 Cookie**
→ 导航 → 编辑器卸载补保存这一刻才发出 → **凭证已经没了** → 401 → 字丢了。
而顶栏的"登出"是静默的,用户当然会以为"登出总是安全的"。

现在编辑器的待保存状态登记在 `lib/pending-save.ts` 的**模块级登记表**里,
登出前调 `flushAllPendingSaves()` 逐个 `await` 冲干净(并发冲刷会互相制造 409)。
它**返回"没冲掉的条数"而不抛异常**:登出必须能继续,用户点了登出就得让他登出去,
但调用方要**知道**有东西没存上,好据此确认一次。

⚠️ `beforeunload` 那条 `sendBeacon` 路径**不受这个机制保护** ——
页面正在卸载,任何人都 await 不了,它只能继续靠 beacon。

⚠️ **第二条依赖一个不显眼的前提:`navigator.sendBeacon` 只能发 POST。**
所以服务端**必须**同时注册 `POST /nodes/:id/content`,否则那次兜底保存会打到一条
不存在的路由上、被丢掉一个 404 —— 而页面正在卸载,没有任何地方会看到它,
表现与"没加 beacon"完全一样。这条路由因此是**必需的**,并在 `verify-org` 里有断言钉住。

⚠️ 卸载时**不能**再问编辑器要 `getJSON()`:React 按声明顺序清理 effect,
`useEditor` 的销毁排在前面。所以每次输入时就把快照存进 `snapshotRef`。

⚠️ 保存失败要**把原因显示出来**,并且区分两类:
参数校验类(`VALIDATION_FAILED`,如正文超 2MB)**重试不会成功**,
说"继续输入会自动重试"是误导;网络类才是可以再试的。

### 7.6 其余界面能力

| 能力            | 说明                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `Modal`         | `role=dialog` + `aria-modal`;焦点移入与还原;Tab 循环不逃逸;Esc 关闭;锁 **`<main>`** 滚动 |
| `Toast`         | 常驻的 `aria-live=polite` 容器;错误用 `role=alert`                                       |
| `ErrorBoundary` | 渲染期抛错时显示可读页面,而不是整片白屏                                                  |
| `ErrorNote`     | 显示一句红字;**调用方给了 `onRetry` 才**附「重试」按钮                                   |

⚠️ **`Modal` 锁的是 `<main>` 而不是 `document.body`(v5.43 更正)。**
真正滚动的是 `AppLayout` 里的 `<main class="overflow-auto">`,`body` 根本滚不动 ——
原来锁 `body.style.overflow` 在真机上完全无效(打开对话框后 `<main>` 的
`overflow` 仍是 `''`),真机实测翻车后才改的。判据是「此刻能不能滚」,
不是「内容够不够长」。

⚠️ **`ErrorNote` 的「重试」是可选的。** `onRetry` 是可选参数,而 `NodeDetail`
当前**没有**传 —— 所以它在那儿只显示一句红字。文档曾写成"失败时给重试按钮",
读起来像是必有的,排查时容易被误导。

| 树键盘导航 | ↑↓ 走可见顺序;→ 展开/进子节点;← 折叠/回父节点;Home/End;Enter 打开 |
| 打印 / PDF | `window.print()` + `@media print`。**零新依赖** |
| 检索高亮 | 命中词用 `<mark>`;切分函数满足「拼回去 === 原文」的固定不变式 |

⚠️ **打印时"哪些不印"必须由元素自己声明(`data-print="hide"`),不能靠标签名猜。**
曾用 `header` 选择器隐藏"页面框架",但**文档页自己的标题与元信息也装在 `<header>` 里** ——
于是打印稿没有标题。框架(顶栏、左树、右栏、工具栏)现在都显式带 `data-print="hide"`。

> **为什么导出 PDF 走浏览器而不是服务端:** 服务端生成要引入一整条渲染链,
> 在**内网离线**环境里既加体积又加维护面,而用户要的只是「能打出来 / 能存成 PDF」。

### 7.7 无障碍

- 全局 `:focus-visible` 焦点圈;`.kc-prose { overflow-wrap: anywhere }`。
- 树是 `role=treeitem` + `aria-expanded` / `aria-level` + **roving tabindex**。
  ⚠️ 它的判据是**三项**(`v5.43` 补记,此前文档只说"roving tabindex",
  读起来像是漏了兜底):`focusedId === id` ‖ `是当前打开的节点` ‖
  **`是可见节点里的第一行`**。第三项是 v4.9 补的 —— 在 `/`、`/search`、`/audit`
  这些没有 active 节点的页面上,前两项对每一行都是 false,于是整棵树一个
  tab stop 都没有、键盘永远进不去。补上之后"任意时刻恰好一个 tab stop"
  在**树非空**时恒成立;**树为空**时不存在可聚焦的行,这是必然的而非缺陷。
- 弹窗、toast、骨架屏都有对应的 ARIA 角色(见 §7.6)。

---

## 8. 关键流程

### 8.1 移动节点(最容易做错的一个)

移动 = 改父级 + 重排位置,**同一个接口**(`POST /nodes/:id/move`)。

```sql
-- 一条语句覆盖整棵子树:从「旧前缀长度 + 1」处截掉旧前缀,再接上新前缀
UPDATE nodes
   SET materialized_path = <新路径> || substr(materialized_path, <旧前缀长度 + 1>::int),
       depth = depth + <新深度 - 旧深度>::int
 WHERE id = <节点>
    OR materialized_path LIKE <旧前缀> || '%'
```

自身(整串等于旧前缀)截出来是空串,恰好得到新路径;子孙则保留下半段相对路径。
(PostgreSQL 里同一语句的 `WHERE` 与 `SET` 都读**更新前**的值,所以自身那一行也适用同一公式 ——
这一点曾被人误判为"自身路径会被重复拼接",实际不会。)

**五条必须记住的:**

1. **防环**:目标不能是自己或自己的子孙。判据用**物化路径前缀**(带尾斜杠)。
2. **目标父节点也要 `canEdit`**。否则可以把节点「搬进」一个自己无权动的分支。
3. ⚠️ **必须用 `substr(x, $n::int)`,不能写 `substring(x from $n)`。**
   PostgreSQL 里 `substring(string from pattern)` 是 POSIX 正则那一种,
   当参数类型是 `unknown` 时会被解析到**正则分支,结果静默返回 NULL**。
4. ⚠️ **`depth` 的增量必须与 `create` 同一个语义**(`newParentDepth + 1 - row.depth`)。
   算错会让整棵子树的 `depth` 系统性偏移,而 `deleteSubtree` 正是靠 `depth` 分层删除的。
5. ⚠️ **目标父节点的路径必须在事务内重读。** 校验阶段拿到的路径只是快照;
   并发把目标移走之后再用它重写子树,会造出一棵**父节点已不在那个位置**的子树 ——
   而权限判定靠物化路径取祖先链,链断之后是**静默判权错误**,且不会自愈。
   注意 Serializable 隔离级别救不了它:谓词锁只覆盖**事务内实际访问过**的数据,
   而这个事务从未读过目标那一行。

位置用 `makeRoomAt` 实现。⚠️ 它必须 `excludeId` —— 被移动的节点此刻**还挂在原位置**。

**单节点移动与批量移动共用 `applyMoveTo()`** —— 抄一份出来的代价是某天有人只修了其中一份,
而物化路径写错的表现是「某棵子树的祖先链错了」,**不报任何错**。

### 8.2 删除(物理删除,不可恢复)

**没有回收站,没有保留策略。** 删除就是立即、不可恢复的物理删除,**整棵子树一起删**。

`NodeService.deleteSubtree` 每轮**重新查一次**当前剩余的子树行,找出最深的一层删掉,
循环到空为止。顺序是刻意的:**按深度从叶子往根删**,不是靠数据库的级联 ——
`nodes.parent_id` 是 `onDelete: Restrict` 而 `DELETE` 不支持 `ORDER BY`。

⚠️ 若因数据不一致(`depth` 与真实父子关系对不上)撞上外键约束,
现在会被翻译成一句可读的 400 提示,而不是裸的 500「服务器内部错误」——
并且整个事务回滚,**一个节点都不会被删掉**。

**删除的门槛是 `canManage`(祖先链所有者),不是 `canEdit`。**

> ⚠️ **上线前必须让使用者知道这一条:误删无法挽回。** 只能从备份里找。
> 要确认是谁删的,进 `/audit` 搜 `node.delete`。

### 8.3 检索

```sql
SELECT n.id, n.title, n.materialized_path, COALESCE(c.text_for_search, ''), n.updated_at
  FROM nodes n
  LEFT JOIN node_contents c ON c.node_id = n.id      -- ← 必须是 LEFT
 WHERE n.title ILIKE %q% OR COALESCE(c.text_for_search, '') ILIKE %q%
 ORDER BY <命中位置权重> DESC, similarity(...) DESC, n.updated_at DESC
 LIMIT 20;
-- 然后对这最多 20 条逐条做 canRead 判定,读不到的丢掉
```

**① `LEFT JOIN` 不是可选的。** 用 `JOIN` 会让**没有正文的节点(纯「组 / 部门」)**
永远搜不到,哪怕标题完全匹配。`COALESCE` 同样不能省:`NULL ILIKE …` 求值为 NULL(不是 false)。

**② 权限过滤写在代码里,不写进 SQL。** 命中已被 `LIMIT 20` 收窄,这里最多 20 次判定;
而在 SQL 里再写一遍判定,等于**把安全逻辑实现第二遍**。

> ⚠️ **检索是最容易漏的一条读取路径**(见 §5.6)。

### 8.4 组织架构导入(Excel)

```
GET  /admin/org/import-template   → 下载 .xlsx(带当前全部人员与节点)
       在 Excel 里改
POST /admin/org/import?dryRun=true                          → 上传,只返回差异预览,不写库
POST /admin/org/import?dryRun=false&contentHash=<预览返回值>  → 确认写入(一次事务)
```

> ⚠️ **只有显式写 `dryRun=false` 才会写库。** 解析是显式白名单
> (`org.controller.ts` 的 `parseDryRun`):`true` / `1` / 省略 / 空串 = **预览**,
> `false` / `0` = 写入,其余写法一律 **400**。
> 两点反直觉,必须知道:
>
> 1. **省略 `dryRun` 等于预览,不是写入。** 这一版文档此前把它写反了
>    (旧文写"不带参数 → 确认写入")。默认落在不写库的那一侧是刻意的。
> 2. **`dryRun=0` 以前会被当成预览**(旧实现是 `dryRun !== 'false'`),
>    也就是"以为写进去了、其实没有,而且不报错";现在它按字面意思就是写入,
>    认不得的写法直接 400,不再靠猜。
>
> ⚠️ **确认写入必须带 `contentHash`**(预览响应里返回的那个)。它是"我确认的就是
> 刚才预览的那一份"的凭据:不一致回 **409**;**完全不带它也是 400,不放行** ——
> 否则预览与确认之间文件被换掉就不会有人发现。这条契约由服务端强制,
> 三处调用点(`seed-dev.mjs` / `verify-org.mjs` / 前端导入向导)都已经带上它。

**第二步与第三步是同一个接口的两个模式**,不是两个接口。
服务端只有一份解析与差异计算逻辑(`org/import.core.ts` 的 `planImport`)。

增量语义:

| 表格里的情况         | 处理                                                                |
| -------------------- | ------------------------------------------------------------------- |
| 工号不存在           | 新建(`status=active`,初始密码 `123456`,`must_change_password=true`) |
| 工号已存在           | 不新建;按需要补上归属                                               |
| 工号已存在但姓名不同 | 以表格为准**更新姓名**                                              |
| 归属已存在           | 跳过(**幂等**)                                                      |
| 归属不存在           | 新增一条归属                                                        |
| 表格里**没出现**的人 | **完全不动**                                                        |

> 因此:同一份表格上传第二遍、第三遍都不会重复建号,可以放心反复上传。

⚠️ **已知限制:「把人从某个组移出去」做不到。** 增量语义下,「表格里没写」与「要删掉这条归属」
**无法区分**。所以界面上必须有「节点成员」入口作为配套(§8.6)。

模板必须有**两列 ID**(`部门ID(勿改)` + `组ID(勿改)`):一列只能标识「最深那个节点」,
遇到「组是新建的 + 部门刚改名」时仍会重复建部门。

两条实现要点:

- **权限检查必须在文件校验之前。** 权限不足就该一律 403。
- **解析与写库共用同一份纯逻辑**。预览与确认走同一份代码。

### 8.5 批量移动

`POST /nodes/bulk/move`,body 为 `{ nodeIds, newParentId }`,一次最多 **50** 个(`BULK_MOVE_MAX`)。

**只做移动,不做批量删除。** 移动可逆,而删除不可恢复 —— 两者的风险差一个量级。

| 限制                                        | 漏了会怎样                                          |
| ------------------------------------------- | --------------------------------------------------- |
| 不能移到**它自己或它的子孙**下              | 物化路径变成自引用,权限判定被一起带偏               |
| 批量里**不允许互为祖先**                    | 结果取决于执行顺序;**直接拒绝比猜用户想要什么清楚** |
| 校验**全部通过才写**,一个事务里全做或全不做 | 不做"部分成功 + 失败清单"                           |

位置一律**追加到目标末尾**。**权限:逐节点 `requireEdit`,目标也要 `requireEdit`。**

⚠️ **批量移动不校验也不递增 `version`**(DTO 里没有这个字段)。
已知欠账:批量移动之后前端手里的 `version` 仍是旧的,乐观锁察觉不到这次改动。
并发下不会损坏数据,但"后写覆盖前写"是可能的。

⚠️ **执行阶段同样要在事务内重读目标路径**(理由见 §8.1 第 5 条),并按新路径重做防环判定。

### 8.6 成员与授权是两件事

它们看起来都在回答「这个节点上都有谁」,共享一个入口位置与一套候选人过滤,
但**没有合并**,因为混在一起会让「移出成员 = 收回权限」变成一种反复出现的误解:

- 移出归属**不改变所有权**:被移出的组长仍然是组长;
- 但**会缩小他的组织范围**:若是他最后一条归属,他将不能在别人下面新建、也不能被授权。

这两句写在移出前的确认框里(`features/members/removal-note.ts`)。

> ⚠️ **超管不在 `canManage` 之列**(他不是内容所有者),但成员维护与组织范围对超管放行 ——
> 见 `OrgService.requireManageMember`、`memberCandidates` 与 `scopeOptions`。

---

## 9. 运维

### 9.1 配置项

<!-- BEGIN GENERATED:env -->
<!-- prettier-ignore-start -->
| 环境变量 | 默认值 / 取值 |
|---|---|
| `API_PORT` | `toInt(process.env.API_PORT ?? process.env.PORT, 3000)` |
| `APP_VERSION` | `process.env.APP_VERSION ?? '0.1.0'` |
| `DATABASE_URL` | `跨行赋值,见 configuration.ts` |
| `LOGIN_IP_MAX_FAILURES` | `toInt(process.env.LOGIN_IP_MAX_FAILURES, 100)` |
| `LOGIN_IP_WINDOW_MINUTES` | `toInt(process.env.LOGIN_IP_WINDOW_MINUTES, 15)` |
| `LOGIN_LOCK_MINUTES` | `toInt(process.env.LOGIN_LOCK_MINUTES, 15)` |
| `LOGIN_MAX_ATTEMPTS` | `toInt(process.env.LOGIN_MAX_ATTEMPTS, 5)` |
| `NODE_ENV` | `跨行赋值,见 configuration.ts` |
| `REDIS_URL` | `process.env.REDIS_URL ?? 'redis://localhost:6379'` |
| `SESSION_COOKIE_SECURE` | `toBool(process.env.SESSION_COOKIE_SECURE, isProduction)` |
| `SESSION_SECRET` | `process.env.SESSION_SECRET ?? ''` |
| `SESSION_TTL_HOURS` | `toInt(process.env.SESSION_TTL_HOURS, 24 * 30)` |
| `UPLOAD_DIR` | `process.env.UPLOAD_DIR ?? './data/uploads'` |
| `UPLOAD_MAX_PER_WINDOW` | `toInt(process.env.UPLOAD_MAX_PER_WINDOW, 30)` |
| `UPLOAD_WINDOW_MINUTES` | `toInt(process.env.UPLOAD_WINDOW_MINUTES, 5)` |
| `WEB_ORIGIN` | `process.env.WEB_ORIGIN ?? (isProduction ? '' : 'http://localhost:5173')` |

共 **16** 个。由 `scripts/gen-doc.mjs` 从 `configuration.ts` 生成;与 `.env.example` 的双向比对由 `pnpm audit:docs` 负责。
<!-- prettier-ignore-end -->
<!-- END GENERATED:env -->

对应地,`.env.example` 声明了部署时需要填的键。两者的**双向比对**由 `pnpm audit:docs` 负责。

### 9.2 常用命令

> ⚠️ **先分清「在哪台机器上跑」。** 这两类命令的**运行位置不同**,混着写会让人在部署机上白试半天:
>
> - **部署机(生产服务器)**:只装了 `node` / `npm` / `npx`,**没有 pnpm**,也**没有 `node_modules`**
>   (实测)。所以下面那张表里 `pnpm …` 那几条**在部署机上一定跑不起来**
>   —— 开发机上(装了 pnpm 并 `pnpm install` 过)才行。
> - **容器内**:`node` 在,`scripts/` 也在(随镜像发布)。
>
> 在部署机上要跑验收/自检,用**容器内**的形式(见本节结尾那段),不要用 `pnpm`。

**开发机**(装了 pnpm、`pnpm install` 过):

```bash
pnpm check                          # typecheck + lint + format:check + audit:docs
pnpm build                          # nest build + vite build
pnpm verify:org                     # 端到端验收(跑之前先 seed:dev)
pnpm db:verify                      # 数据库契约自检(scripts/verify-db.mjs)
pnpm seed:dev                       # 演示数据(**需要先清库**,不做幂等)
```

**部署机**(`~/knowledgeCool`,四个容器已经在跑):

```bash
docker compose up -d                # 开机后把四个容器拉起来(⚠️ 绝不能加 -v,那会清库)
docker compose up -d --build        # 改了代码之后重建镜像(数据库迁移会自动应用)

./scripts/backup.sh                 # 备份到 ./backups/<时间戳>/
./scripts/restore-drill.sh          # 演练最近一份备份(**不碰生产库**)
./scripts/migrate-export.sh         # 打包成一个可搬运的迁移整包(§9.5.3)
./scripts/migrate-import.sh <包>    # 在目标机上导入(校验和 → 恢复 → 逐表对账)
```

> ⚠️ **Windows 上用 Git Bash 跑这些 `.sh`**(仓库依赖 bash 的重定向做字节精确的
> 管道;`pwsh` 的 `>` 会按文本编码重写,会**损坏二进制 dump**)。脚本内部已关掉
> MSYS 的路径翻译(§9.5.3 的第 1 条),直接 `bash scripts/backup.sh` 即可。

⚠️ **在容器里跑验收脚本时必须带 `-e KC_API` 与 `-e KC_ROOT`** —— 两者缺一不可:

```bash
docker compose exec -T -w /app/apps/api -e KC_API=http://web/api/v1 -e KC_ROOT=http://web \
  api node scripts/verify-org.mjs

# 文档行为断言(17 项)用同一对变量(按脚本路径调用,不是 pnpm 命令)
docker compose exec -T -w /app/apps/api -e KC_API=http://web/api/v1 -e KC_ROOT=http://web \
  api node scripts/verify-doc-claims.mjs

# 接口健壮性(51 项):把 API 当外部边界打 —— 任何 5xx 都算缺陷
# 覆盖:全路由异常输入 / 「不存在 vs 无权访问」不可区分 / 方法混淆
docker compose exec -T -w /app/apps/api -e KC_API=http://web/api/v1 -e KC_ROOT=http://web \
  api node scripts/verify-robustness.mjs

# 数据库契约自检(不需要那两个变量)
docker compose exec -T -w /app/apps/api api node scripts/verify-db.mjs
```

> `verify-robustness.mjs` 会**真的登录**(`KC002`,密码取 `KC_SEED_PASSWORD`,默认 `Kc-verify-2026`)。
> ⚠️ **必须先有会话** —— 未登录时每条请求都是 401,而 401 看起来也像「干净的客户端错误」,
> B 段会整体误报。(这个脚本的第一版就漏了登录,8 条全红、报的全是 401。)
> 反复失败会撞上登录限流,先清:`docker compose exec redis sh -c 'redis-cli --scan --pattern "kc:login*" | xargs -r redis-cli del'`。

> ⚠️ 两个脚本都必须**两个变量都给**:脚本里除了打接口,还有几条断言要打
> **由 Nginx 直出**的地址(SPA 路由)。只给 `KC_API` 的话,那几条会去连
> `127.0.0.1:8080` —— 而在 api 容器里那是它自己的回环,必然 `ECONNREFUSED`。

> ⚠️ **反复跑带登录的验收会把自己限流。** 连着跑几遍 `verify-org` 之后,
> `kc:login:fail:ip:*` 会累积到上限,后续登录返回 `RATE_LIMITED` 而不是 `UNAUTHORIZED`,
> 于是「两种失败的错误体必须一致」那条安全断言会**假失败** —— 看起来像个漏洞。
> 跑之前先清:
>
> ```bash
> docker compose exec -T redis sh -c 'redis-cli --scan --pattern "kc:login*" | xargs -r redis-cli del'
> ```

### 9.3 账号与登录

- **工号 + 密码**登录。新账号初始密码统一 `123456`,首次登录强制改密(§6.1.2)。
- **管理员重置密码**:`POST /admin/users/:id/reset-password`。它会做三件事:
  ①密码重置回 `123456`;②置 `must_change_password`;③**吊销该用户全部会话**。
  两条刻意的拒绝:**不能重置自己**;**不能重置一个登不进来的人**。
- **改状态会立刻踢下线**:改成停用或离职时,服务端会删掉该用户全部会话行。
- **不能把最后一个在职管理员停用 / 离职。** 那会把系统锁死,而且**没有界面能改回来**。

### 9.4 登录被锁了怎么办

**同一个工号连续输错 5 次密码,锁 15 分钟;锁定期内即使密码正确也登不进去。**

```bash
# a) 等 15 分钟(锁会自动过期,不需要任何操作)

# b) 立刻解锁某一个工号:
docker compose exec -T redis redis-cli del kc:login:lock:u:kc004
```

> ⚠️ **Redis 挂了的时候锁定会失效,这是刻意的取舍**(§6.1.3)。

### 9.5 数据留存、备份与迁移

#### 9.5.1 数据存在哪(为什么重启不会丢)

三份数据全部落在 **Docker 具名卷**上(见 `docker-compose.yml` 的 `volumes:`):

| 卷                            | 挂到                                | 装什么                                                    |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------- |
| `knowledgecool_postgres-data` | postgres:`/var/lib/postgresql/data` | **全部业务数据**(用户 / 节点 / 正文 / 评论 / 审计 / 会话) |
| `knowledgecool_uploads`       | api 与 web:`/data/uploads`          | 附件                                                      |
| `knowledgecool_redis-data`    | redis:`/data`                       | 权限缓存、登录限流计数(丢了不影响正确性)                  |

所以下面这些动作**都不会**丢数据:

- 重启电脑 / 重启 Docker Desktop
- `docker compose restart`
- `docker compose up -d --build`(重建 api / web 容器)
- **连 postgres 容器被重建也没事** —— 命名卷与容器生命周期无关

⚠️ **唯一会清库的是 `docker compose down -v`**(那个 `-v` 就是"连卷一起删")。
没有任何部署步骤需要它,别顺手加。

⚠️ **容器不会"自动回来"**:Docker Desktop 退出时会优雅地停掉容器,那算一次
**显式停止**,于是 `restart: unless-stopped` 按语义**不会**把它们拉起来。
开机后手动跑一次 `docker compose up -d` 即可(不要加 `-v`、通常也不用 `--build`)。

#### 9.5.2 备份与恢复演练

`scripts/backup.sh` 备份到 `./backups/<时间戳>/`,内容:

| 文件             | 是什么                                     |
| ---------------- | ------------------------------------------ |
| `db.dump`        | `pg_dump -Fc` 导出,`pg_restore` 可按表恢复 |
| `uploads.tar.gz` | 附件目录                                   |
| `manifest.txt`   | 逐表行数快照(恢复后用来对账)               |
| `env.snapshot`   | `.env` 原样一份(权限 600)                  |

⚠️ **`env.snapshot` 不是可有可无的。** 库导出来了,但「连上这个库」要用的密钥
(`SESSION_SECRET`、`POSTGRES_PASSWORD`)既不在 dump 里也不在仓库里。
服务器整个没了的时候,只拿着一份 `db.dump` 是重建不出一套能用的部署的。
代价是备份目录从此含密钥,所以目录权限收到 700。

⚠️ **备份失败时会自己删掉半成品目录。** 一个残缺的目录留在 `backups/` 里,
会被保留期逻辑、`restore-drill` 的「取最近一份」、以及定时任务**当成一份正常备份**。
于是最坏的情况不是「没有备份」,而是「以为有备份」。

`scripts/restore-drill.sh` 把一份备份恢复到**临时库**并逐表比对行数(不动生产库);
`restore.sh` 才是真正的恢复。

##### 定时备份(每天 5:00)

两个给 cron 用的入口。它们**自己不导数据、不恢复数据** ——
那两件事各自只有一份实现(`backup.sh` / `restore-drill.sh`),这里只补 cron 需要的部分:

| 脚本                    | 补了什么                                               |
| ----------------------- | ------------------------------------------------------ |
| `backup-cron.sh`        | 磁盘余量守卫、日志、**校验新 dump 可读**、按保留期清理 |
| `restore-drill-cron.sh` | 日志、取**最近一份**演练、清理上次失败残留的临时库     |

```cron
# 每天早上 5 点全量备份
0 5 * * * $HOME/knowledgeCool/scripts/backup-cron.sh
# 每周日 05:30 做一次真正的恢复演练(恢复到临时库并逐表比对行数)
30 5 * * 0 $HOME/knowledgeCool/scripts/restore-drill-cron.sh
```

可调项(都在 `backup-cron.sh` 顶部):`BACKUP_KEEP_DAYS`(默认 30 天)、
`BACKUP_MIN_FREE_MB`(默认 2048)。日志在 `~/knowledgecool-backup.log`,
脚本自己会剪到最近 3000 行。

⚠️ **为什么每天只做轻校验、每周才做真演练:** `pg_restore --list` 只证明归档没坏,
**不证明能恢复** —— 而真正会骗人的失败恰恰是「演练没覆盖到的那一步」
(§9.5.3 第 2 条就是活例:`restore-drill` 一直通过,真恢复却断在附件那一步)。
所以轻校验每天做,真演练每周做。

⚠️ **cron 的 PATH 极简,`docker` 往往不在里面。** 不补 PATH 的定时任务会以
`docker: command not found` 失败,而同一行命令手工在终端跑却是好的 ——
排查「cron 没执行」时先看这一条。两个脚本里都已经显式补了。

> ⚠️ **已知风险:备份与数据同盘。** 该盘整体故障时数据与备份会一起丢。
> 这几个脚本只负责**产生**和**校验**备份;把它同步到异地(另一台机器 / 对象存储)
> 是部署方的责任,脚本无法代劳。**留在同一块磁盘上等于没有备份。**

#### 9.5.3 全量迁移到另一台机器

```
源机器:./scripts/migrate-export.sh          → 一个 .tar.gz 整包
目标机:./scripts/migrate-import.sh <包>      → 校验 → 恢复 → 逐表对账
```

包里有:库导出、附件、逐表行数、**来源机的 `.env` 原样一份**、来源机的 git commit、
以及 `SHA256SUMS`。导入端**先校验校验和再碰任何现有数据**。

⚠️ 包里含密钥与全公司数据,按机密资料对待(用 `scp`/`sftp`,别丢公共网盘)。

**导出逻辑只存在一份**:`migrate-export.sh` 调 `backup.sh` 拿标准备份,
再往上加"迁移才需要的东西";导入端同理交给 `restore.sh`(§12)。

⚠️ **两个曾经真实存在、而且都是"检查/演练看不见"的缺陷(已修)**:

1. **Windows 上备份/恢复根本跑不通。** Git Bash(MSYS)会把**独立出现的**绝对路径
   参数翻译成 Windows 路径:`docker compose exec -T api tar -C /data/uploads .`
   会被改成 `tar -C D:/git/Git/data/uploads` → 附件那一步必失败。
   它**不是**无条件翻译(藏在引号里的一整条命令没事),所以看起来像"那条命令有问题"。
   现在**七个**脚本开头都 `export MSYS_NO_PATHCONV=1`(Linux 上等于无操作)。
2. **`restore.sh` 真恢复时会断在附件那一步。** 它先 `stop api`,然后又用
   `docker compose exec -T api` 往卷里解附件 —— **exec 进不去已停止的容器**。
   最坏的地方在于它断在库已经 drop 重建之后。而 `restore-drill.sh` **看不到这个错**:
   它只在宿主机上 `tar -tzf` 校验附件包,从不真的往容器里写。
   → **演练通过 ≠ 真恢复能过**;现在附件改用 `docker compose run --rm -T --no-deps api`
   (另起一次性容器挂同一个卷,不要求服务在跑)。

⚠️ 另外一条算"检查本身失效"的教训,写在 `migrate-import.sh` 里:
它的对账循环曾因为 `psql` 把 manifest 从 stdin 读走而**只核对了第一张表**,
却打印"行数与源包完全一致"。**一个只检查了一行的检查,比没有检查更危险。**

### 9.6 常见故障

| 现象                             | 原因                                          | 处理                                                            |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| 登录成功但刷新后回到登录页       | `SESSION_COOKIE_SECURE=true` 却在用 http 访问 | 改成 `false` 后 `docker compose up -d`                          |
| api 容器反复重启                 | 数据库没起来 / 密码不对                       | `docker compose logs api`                                       |
| 页面能开、接口 502               | api 未 ready                                  | `docker compose ps`;看 `migrate deploy` 是否失败                |
| 图片 404                         | web 容器没挂到 uploads 卷                     | `docker compose config` 看 web 的 volumes                       |
| 中文搜索搜不到                   | `pg_trgm` 扩展或三元组索引丢失                | `pnpm db:verify` 会检查                                         |
| **有人密码明明是对的却登不进去** | 连续输错 5 次触发了登录锁定                   | 等 15 分钟,或按 §9.4 解锁。**先查这一条**                       |
| **有人看不到某篇文档**           | 节点被设成**受限**,而他不在读者名单里         | 让该节点的创建者或所有者打开「可见范围」把人加进去              |
| **有人误删了文档**               | 删除是物理删除,没有回收站                     | **无法恢复**,只能从备份找。查是谁删的:`/audit` 搜 `node.delete` |
| 某人不在某个组的成员列表里       | 他的归属被移出,或本来就没加过                 | 调岗是**两步**:先加入新节点,再从原节点移出                      |

### 9.7 首次部署

| 项       | 要求                                                    |
| -------- | ------------------------------------------------------- |
| 操作系统 | Linux x86_64(Ubuntu 22.04+ 实测);Windows 只作为开发机   |
| Docker   | 24+,需要 `docker compose` v2 语法                       |
| 内存     | **2 GB 起,建议 4 GB**                                   |
| 磁盘     | 20 GB 起(镜像 + 数据 + 附件 + 备份)                     |
| 端口     | 一个对外端口(默认 8080);80/443 被占用时用 `WEB_PORT` 改 |

```bash
docker --version && docker compose version
cp .env.example .env      # 然后填 POSTGRES_PASSWORD 与 SESSION_SECRET(必须随机)
docker compose up -d --build
curl -s localhost:8080/api/v1/health/ready   # 应报告 database 与 redis 均 up
```

**升级:** `git pull && docker compose up -d --build`。⚠️ **升级前先备份**。

> 没有仓库部署密钥时走「本地打包 → scp → 服务器解包」。解包**前必须先清空源码目录** ——
> `tar -xzf` 覆盖不会删除已被移除的文件,旧模块会原样留着,于是 `tsc` 直接失败。

### 9.8 上 HTTPS(有域名时)

最省事是在宿主机用一个 Caddy 反代到 8080:

```caddyfile
kb.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

上完 HTTPS 后把 `.env` 改回 `WEB_ORIGIN=https://kb.example.com`、
`SESSION_COOKIE_SECURE=true`,再 `docker compose up -d`。

### 9.9 上线前检查清单

- [ ] `.env` 里的 `POSTGRES_PASSWORD` / `SESSION_SECRET` 都是随机生成的,不是样例值
- [ ] `SESSION_COOKIE_SECURE` 与访问协议匹配(§2.4)
- [ ] `/api/v1/health/ready` 报告 database 与 redis 均 up
- [ ] 已创建管理员,且库里**没有**遗留测试账号
- [ ] `./scripts/backup.sh` 跑通,且备份已同步到异地
- [ ] `./scripts/restore-drill.sh` 跑通
- [ ] **已把「删除不可恢复」告知使用者**(§8.2)
- [ ] 四个容器都是 `restart: unless-stopped`
- [ ] 出问题时有人知道去哪看日志:`docker compose logs`

---

## 10. 为阶段二预留的硬约束

以下是为「实时协同 / 通知中心」预留的,**现在不做,但现在就不能破坏**:

1. 评论表预留 `anchor_type` / `anchor_text` / `anchor_pos` 三列的位置(行内锚定用)。
2. `SESSION_SECRET` 留给协同网关签短期 JWT 的用途(现在被首登改密借用)。
3. Redis 已开 appendonly(阶段二放"在线态"与队列)。
4. 附件走 `UPLOAD_DIR` 抽象,**不要**在业务代码里拼本地路径。
5. 审计日志的 `detail` 是 JSONB,新动作往里加字段不需迁移。
6. 所有时间列都是 `timestamptz`,不存本地时间。
7. 正文存 ProseMirror 文档树,`ydoc_snapshot` 字段已建好(阶段一保持 null)。

---

## 11. 风险与开放问题

### 11.1 已知风险(接受并留档)

另有四条已在各自章节写明,此处只留指针:**备份与数据同盘**(§9.5)、
**一次性凭证无状态**(§6.1.2)、**Redis 故障时限流失效**(§6.1.3)、**删除不可恢复**(§8.2)。

- **删除节点、变更所有者、批量移动都不校验 `version`**:并发下不会损坏数据,
  但"后写覆盖前写"是可能的(清单在 `schema.prisma` 的 `version` 字段注释里)。

### 11.2 技术风险

| 风险               | 说明                                                                 | 缓解                                              |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| 单机部署无冗余     | 本地卷存附件,机器坏了附件就没了                                      | 备份脚本 + 异地保存                               |
| 大文档编辑器性能   | 几千行的页面,Tiptap 首次渲染会卡                                     | 阶段一可接受                                      |
| `pg_trgm` 检索精度 | 对长文档的相关度排序不如专业搜索引擎                                 | 阶段一数据量下无虞;**上量后必须换 Meilisearch**   |
| 没有自动化单测     | 回归靠 `pnpm verify:org` 与 `apps/api/scripts/verify-doc-claims.mjs` | 这两套跑的是真接口与真数据库,验的是行为而不是实现 |

### 11.3 仍然开放

- **是否需要「仅创建者可见的草稿」这一状态。** `PATCH /nodes/:nodeId` 的 DTO
  (`UpdateNodeDto.status`,`IsIn(NODE_STATUSES)`)确实接受 `draft`,
  也就是说**接口层已经能设置它**,只是界面上没有入口 —— 所以现状是"可用但无人用",
  而不是"未启用"。要么补上界面入口,要么把它从 `NODE_STATUSES` 里删掉。
  ⚠️ 注意它与 `visibility=restricted` 不是一回事:前者是**生命周期**,后者是**访问范围**。
- **评论列表没有上限。** `CommentService.list` 把该节点的评论一次全查出来,
  既不游标分页也不截断(§6.1 记了这条)。审计 50/页、检索 20 条、批量移动 50 个
  都有上限,评论是唯一漏掉的读取路径;单个节点评论上万时会变成一个很大的响应。
- **移动端**:阶段一完全不做。
- **附件的孤儿文件**:上传了但没插进文档的图片不会被回收。⚠️ v4.27 起**有了工具**(`docker compose exec -w /app/apps/api api node scripts/prune-uploads.mjs`,默认只盘点、`--delete` 才真删、且只碰超过 24 小时的文件),但**没有自动化**——需要运维按需跑。真机盘点结果:**19 个文件全部是孤儿**(其中 17 个只有 4 字节,是截断的破图)。
- **重置密码后通知本人**:需要通知中心,属阶段二。
- **`GET /org/tree` 仍是一次性拉全量。** 接口已支持 `?root=` 只取子树,前端暂未用。

---

## 12. 开发约定

- **注释写「为什么」,不写「做了什么」。** 代码已经说明做了什么。
- **凡是写数据的逻辑,只允许存在一份。** 抄一份出来的代价是某天有人只修了其中一份。
- **凡是读数据的逻辑,只允许存在一份**(审计的可见范围、权限判定都在此列)。
- **不要重排章节号** —— 代码注释里引用了它们(§0.4)。
- **不要手改生成块**(§0.1)。改代码后跑 `node scripts/gen-doc.mjs`。
- **新增读取路径时,把它加进 §5.6 那张表,并加进 `verify-org` 的侧信道断言。**
- 提交前跑 `pnpm check`(typecheck + lint + format:check + audit:docs)。
  ⚠️ `typecheck` 会**先构建 `packages/shared`** —— 那两个 app 通过包入口
  (`dist/`)引用它,干净检出时 `dist/` 还不存在,跳过这一步会得到两百多条
  `TS2307: Cannot find module '@knowledgecool/shared'`。这个构建顺序已经写进
  `package.json` 的 `typecheck` 脚本里,不要再把它拆开。

---

## 附:变更记录

> 完整的变更历史在 git 里（`git log --follow DESIGN.md`）。
> 下表只保留**最近几版** —— `audit:docs` 会校验「文档头版本 = 最新一行」，
> 那是它存在的唯一理由；更早的条目没有必要留在正文里。

| 日期       | 版本  | 变更                                                                                                                                                                       |
| ---------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-01 | v5.38 | 记录两条改密入口规则一致性的实测结论（§6.1.2）。                                                                                                                           |
| 2026-10-01 | v5.39 | 记录权限缓存「TTL 是上限、不是常态」的实测结论（§5.5）。                                                                                                                   |
| 2026-10-02 | v5.40 | 补审计与检索索引的迁移（§4.2）；如实记录检索索引受查询形状限制。                                                                                                           |
| 2026-10-02 | v5.41 | 撤销给超管放行的改动；`requireManageForWrite` 加 `action` 参数以修正 403 文案（§5.3）。                                                                                    |
| 2026-10-02 | v5.42 | 移除已废弃的 `verify:doc` 命令引用（§9.2）；超管权限经确认保持现状（§5.3）。                                                                                               |
| 2026-10-03 | v5.43 | 收归超管在成员维护上的例外（§5.3）；检索改 `UNION` 查询形状（§6.2）；审计表加只增触发器（§4.2）；评论列表加上限（§5.4）；前端路由拆包（§7.2）；CI 增加端到端 job（§9.2）。 |
