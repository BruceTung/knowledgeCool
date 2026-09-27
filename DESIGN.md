# 知源 KnowledgeCool · 设计说明书

| 项 | 值 |
|---|---|
| 文档版本 | v3.0 |
| 状态 | 依据**实际代码**重写。事实性表格由脚本生成并被门禁校验,手写内容逐条经真机核验 |
| 定位 | 内网自托管 · 按公司组织架构组织的企业知识库 |

---

## 0. 这份文档凭什么可信

旧版本烂掉的根因不是"写得不用心",而是**它的事实来自记忆**:接口列表、字段列表、
环境变量列表都是手抄的,抄完没有任何东西会发现它与代码不符。于是漂移不断积累,
直到有人撞上 —— 而文档看起来始终是"完整的"。

这一版换了做法,分三层:

### 0.1 事实由代码生成(四张表)

| 生成块 | 来源 | 生成器 |
|---|---|---|
| 接口清单(§6.2) | 各 `*.controller.ts` 的 `@Controller` 与 `@Get/@Post/…` | `scripts/gen-doc.mjs` |
| 数据模型(§4.2) | `apps/api/prisma/schema.prisma` | 同上 |
| 环境变量(§9.1) | `apps/api/src/config/configuration.ts` | 同上 |
| 前端路由(§7.1) | `apps/web/src/App.tsx` | 同上 |

这些表格被包在 `<!-- BEGIN GENERATED:… -->` 与 `<!-- END GENERATED:… -->` 之间。
**手动编辑它们没有意义** —— `pnpm audit:docs` 会重新生成一遍并逐字比对,不一致就让门禁失败。

> **所以:这四张表不可能与代码脱节。** 不是"我保证它是对的",是"它错了就构建不过"。

### 0.2 约束由机器检查

`pnpm audit:docs`(`scripts/audit-docs.mjs`)共八项:

1. **接口**:§6.2 与控制器注册的路由**双向**比对(文档少的、多的都报)
2. **环境变量**:代码读的 ↔ `.env.example` 声明的,双向比对
3. **文件路径**:文档里提到的仓库路径必须真的存在
4. **版本号**:文档头版本 = 变更记录最新一行
5. **前端调用 ↔ 后端路由**:前端写的字符串路径必须都能在后端找到
6. **docker-compose ↔ 代码**:compose 传给 api 的环境变量必须是代码真读的(死开关要报)
7. **弃用结构**:已删除的数据库列/索引不许再出现在源码里
8. **生成块**:§0.1 的四张表与代码一致

### 0.2.1 行为断言怎么办

上一条检的是**结构性事实**(有哪些接口、哪些字段)。但文档里还有一类话是
**从代码读出来、再写成人话**的,比如:

- 「导出传错 `format` 回 400,**而且参数校验先于权限校验**」
- 「审计游标传 `abc` 回 400,不是 500」
- 「人员列表返回 `{ users, total, nextCursor }`」

这类句子机器比对不了 —— 它们是**对行为的断言**。唯一能验的办法是**真的打一次接口**。

`pnpm verify:doc`(`apps/api/scripts/verify-doc-claims.mjs`)就是干这个的:
它对着一套跑起来的实例逐条打请求,把文档里的行为断言核一遍。
⚠️ 它**只读**,不改任何数据。

> 所以这份文档里的每一句"会发生什么",要么指得到代码,要么被这个脚本打过。

### 0.3 其余内容是判断,不是事实

权限模型、关键流程、取舍理由这些是**判断**,没法生成。对它们的要求是:

- **每条判断都要能指到代码**。指不到代码的判断,这里不写。
- 涉及"实际会发生什么"的,用**真机接口核验**过(在后文就地标注)。
- **不写变更记录**,不写"某版本曾经怎样"。历史在 git 里,不在这份文档里。
  这是刻意的:旧文档 2500 行里大半是历史层,而**历史与现状混在一起正是它不可信的第二个原因**。

### 0.4 读这份文档时的约定

- 章节号(§5.6 这类)是**稳定标识**,代码注释里引用了它们,不要重排。
- 带 `⚠️` 的是**踩过的坑**,不是风格建议。
- 表格上方的"由 … 生成"不是装饰,是**这份内容的来源声明**。

---

## 1. 项目定位与范围

### 1.1 定位

内网自托管的**企业知识库**。与通用 SaaS 知识库的差别在于组织方式:
内容直接挂在**公司既有的组织结构**(部门 / 组 / 项目)下,而不是让用户自由创建"空间"。

| | 通用 SaaS 知识库 | 本项目 |
|---|---|---|
| 组织结构 | 用户自建空间,与公司架构无关联 | **就是公司的组织架构**(部门 / 组 / 项目) |
| 谁建空间 | 任何用户 | 只有组织内有权的人;空间对应真实的组织单元 |
| 默认可见性 | 常需逐空间授权 | **默认全员可读**;可按节点显式收紧(§5.6) |
| 部署 | 公网 SaaS | 内网自托管,Docker Compose 四容器 |

### 1.2 已实现的能力(当前状态)

| # | 能力 | 说明 |
|---|---|---|
| 1 | 账号与登录 | 工号 + 密码;首次登录强制改密(§6.1.2);失败限流与锁定(§6.1.3) |
| 2 | 组织架构 | 部门 / 组 / 项目三级(技术上不限层数);Excel 增量导入;人员可多归属 |
| 3 | 内容树 | 空间与页面是**同一种节点**;新建 / 改名 / 移动 / 拖拽排序;**删除即物理删除** |
| 4 | 编辑器 | Tiptap;标题 / 列表 / 代码块 / 图片 / 表格 / 引用;链接气泡;乐观锁 |
| 5 | 权限 | 所有者 + 祖先链 + 显式授权;判权在服务端;缓存可降级(§5) |
| 6 | 保密 | 节点级 `visibility` + 独立读者名单;七条读取路径逐条收口(§5.6) |
| 7 | 检索 | 中文可用(`ILIKE` + `pg_trgm`);按可见性过滤;命中高亮 |
| 8 | 评论 | 页面级讨论串,支持一层回复;**没有"已解决"状态** |
| 9 | 批量移动 | 最多 50 个;拒绝互为祖先的选法;全做或全不做(§8.6) |
| 10 | 审计 | 全量记录;按动作筛选;导出 CSV(与列表同一可见范围) |
| 11 | 导出 | Markdown 导出;打印 / 存 PDF 走浏览器(§7.6) |
| 12 | 个人视图 | 最近浏览 / 收藏 / 检索历史(**只存浏览器本地**) |

### 1.3 明确不做

实时多人协同 · 行内锚定评论 · 通知推送 · SSO / 企业微信登录 · 版本历史与差异对比 ·
语义问答 RAG · 模板中心 · 移动端适配 · 开放 API · 服务端生成 PDF · 回收站(删除不可逆)。

> **写在这里是为了防止开发中途被不断加需求。** 任何人想加需求,先改这一节。

---
## 2. 技术栈

### 2.1 选型

| 层 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript 6 | 前后端同语言,共享类型 |
| 后端 | NestJS 12 | 模块化 + 装饰器路由 + 依赖注入 |
| ORM | Prisma 7 | 生成物在 `apps/api/src/generated/prisma` |
| 数据库 | PostgreSQL 16(`pg_trgm`) | 中文检索靠三元组,不靠分词器(§2.3) |
| 缓存 | Redis 7 | 权限判定缓存;**可降级依赖**(§5.4) |
| 前端 | React 18 + Vite | TanStack Query(服务端状态)+ Zustand(客户端状态) |
| 编辑器 | Tiptap 3 | ProseMirror JSON 存储 |
| 样式 | Tailwind v4 | OKLCH 色;字号刻度见 §7.3 |
| 测试 | Vitest | 纯函数优先;无 jsdom(组件测试因此受限,见 §11.2) |
| 部署 | Docker Compose | 四容器:postgres / redis / api / web |

### 2.2 版本约束(实测,不是"看起来新就行")

- **Node ≥ 22.12**。Prisma 7 要求 `^20.19 || ^22.12 || >=24`,Vite/Vitest 要求 `^20.19 || >=22.12`。
  镜像用 `node:22-alpine` 同时满足两者。
- **pnpm 由 `corepack` 按 `packageManager` 字段拉取**。
- **构建顺序有依赖**:`packages/shared` 必须先 `build`,因为 api 与 web 通过 workspace 链接引用它的 `dist/*.d.ts`。
  直接跑 `tsc` 会找不到类型 —— 这不是配置问题,是 monorepo 的固有顺序。

### 2.3 ⚠️ 中文检索:PostgreSQL 自带分词器不可用

实测结论:**`tsvector` 对中文命中率为 0**。`to_tsvector` 会把中文当作一个不可切分的词,
搜「空间」匹配不到「空间成员按职责划分」。`verify-db` 每次都会实测这一点并打印结果。

所以中文检索走 **`ILIKE` 子串 + `pg_trgm` 相似度**:

- 主排序键是**命中位置**(标题命中 2 分、正文命中 1 分),`similarity()` 只做同档内的次级排序。
- 为什么不用 `similarity()` 当主键:`trgm` 需要至少 3 个字符才有意义,
  中文搜两个字(「权限」「部署」)普遍得 0,排序会退化成不确定顺序。
- `LIKE` 的通配符必须转义。不转的话搜 `100%` 会命中全部内容。

> 这是**方案级**的结论:想上中文全文检索,得换搜索引擎(§11.2),不是在 PG 里调参能解决的。

### 2.4 内网也必须上 HTTPS

会话 Cookie 是 `HttpOnly` 的,而内网同样存在同网段嗅探。
有域名就上 Let us Encrypt;没有域名、用 IP + http 访问时**必须显式设 `SESSION_COOKIE_SECURE=false`**,
否则浏览器不回传 Cookie —— 表现是「登录成功但刷新后回到登录页」。

---

## 3. 系统架构

### 3.1 部署形态(四容器)

```
浏览器 ──▶ web(nginx, 80)── /api/* 反向代理 ──▶ api(NestJS, 3000)──▶ postgres
                │                                        └──▶ redis
                └── /data/uploads(只读挂载,nginx 直接出图,不经过 Node)
```

| 容器 | 镜像 | 职责 |
|---|---|---|
| `postgres` | `postgres:16-alpine` | 主库;`pg_trgm` 扩展 |
| `redis` | `redis:7-alpine` | 权限缓存、登录限流计数;开了 appendonly |
| `api` | 自行构建 | NestJS;**启动时先 `prisma migrate deploy` 再起服务** |
| `web` | 自行构建 | 构建前端产物 + nginx 反代 |

几个要点:

- **附件目录 `uploads` 由 api 与 web 共享**(web 只读)。上传与读取看到的是同一批文件。
- **迁移随容器启动自动应用**,幂等;不用手工跑 `migrate deploy`。
- 运行阶段**不装 pnpm**:启动路径上不需要包管理器。
  历史上在这里写过 `pnpm exec prisma migrate deploy`,后果是每次启动都让 corepack 去外网拉 pnpm ——
  既是几十秒延迟,也让「启动」依赖外网可达。现在直接调 `./node_modules/.bin/prisma`。

### 3.2 分层职责

| 层 | 职责 | 不该做的事 |
|---|---|---|
| 控制器 | 取参数、调服务、定 HTTP 形状 | 不写业务判断 |
| 服务 | 业务规则与判权 | 不碰 `req`/`res` |
| 纯函数(`packages/shared`) | **权限判定**、可见性过滤、CSV、路径计算 | 不碰数据库 |
| Prisma | 数据访问 | 不写业务规则 |

> **权限判定刻意做成纯函数**。它是「错了不会报错」的逻辑(表现为某人多看到一点东西),
> 必须能被单测直接覆盖。写在服务里面要连着 Prisma 一起 mock 才测得到,而那种测试没人会写。

**Redis 的位置:缓存,不是数据源。** 连接失败或取不到世代号时一律回源数据库,
判定的正确性不依赖它。

---
## 4. 数据模型

### 4.1 设计要点

- **空间与页面是同一种东西**(`nodes` 一张表)。`kind` 只影响展示(图标 / 默认展开),
  **不影响任何权限判定** —— 不要在权限代码里对 `kind` 做分支。
- **树用物化路径**(`materialized_path`),不用递归 CTE。
  一次 `UPDATE … WHERE materialized_path LIKE '前缀%'` 就能移动整棵子树,而且**不可能漏掉某个后代**。
  代价:改父级要重写路径,所以移动是"写放大"的操作(§8.5)。
- **`depth` 冗余存了一份**。可以从路径算出来,但树渲染要用它排序,存下来省一次计算。
- **乐观锁用 `version`**。所有改内容的接口都带 `version`,不匹配回 409 ——
  两个人同时编辑同一篇,后到的那个会明确失败,而不是静默覆盖。
- **没有软删除**。删除是物理删除,整棵子树一次删掉(§8.2)。

### 4.2 表结构

<!-- BEGIN GENERATED:models -->
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
<!-- END GENERATED:models -->

### 4.3 几处反直觉的地方

- **`node_readers` 与 `node_grants` 是两张表**,不是一个"权限"表的两种取值。
  前者回答「谁能**读**」(保密),后者回答「谁能**改**」(授权)。它们判定口径不同、管理权限也不同(§5.6)。
- **`org_assignments` 允许一个人挂在多个节点上**(多归属)。
  「移出归属」不等于「收回权限」:被移出的组长仍然是组长(§8.4)。
- **`audit_logs.id` 是 `BigInt`**,JSON 装不下 64 位整数,所以对外一律按**字符串**往返。
  游标分页因此要显式校验(§6.4)。
- **`nodes.visibility` 是 `TEXT` + CHECK 约束**,不是 PG 枚举类型。
  用 `TEXT` 是为了加取值时不用 `ALTER TYPE`(那在旧版本 PG 上要建索引重建)。
- **`node_contents.content_json` 是 JSONB**,同时存一份 `text_for_search` 纯文本。
  后者由纯函数从 ProseMirror 文档抽取,专供检索 —— 免得每次搜索都解析 JSON。

---

## 5. 权限模型

### 5.1 三个概念

| 概念 | 含义 | 存在哪 |
|---|---|---|
| **所有者** | 节点的责任人。一级节点是"部长",二级是"组长" | `nodes.owner_id` |
| **授权** | 额外允许某人改这个节点 | `node_grants` |
| **组织归属** | 谁属于哪个组织单元(决定他能给谁授权) | `org_assignments` |

判定写成 `packages/shared/src/permission.ts` 里的**纯函数**,有单测。

### 5.2 三条定稿规则

| 规则 | 含义 | 为什么 |
|---|---|---|
| **读默认开放** | 默认所有节点对所有登录用户可读;**显式设成「受限」的节点只有读者名单能看到**,整棵子树继承 | 知识库的价值在于共享。但总有例外(人事、薪酬、未定稿方案),所以给一条逐节点、显式、可审计的口子 |
| **编辑权沿祖先链继承,且不可被拒绝** | 上层所有者天然能改下层的一切;没有 deny | 管理链条上每一级都要能介入下属的内容。收回权限的唯一手段是**从授权名单里删行** |
| **授权受组织范围约束** | 操作者只能授权给**落在自己组织范围内**的人 | 防止横向越权:组长不该能把权限给到别的部门的人 |

「组织范围」的定义:

```
orgScope(user) = 该用户所有 org_assignments 指向的节点及其全部后代
```

举例:组员 A 属于「后端组」。A 在组下建了子空间 S 且是 S 的所有者,因此 A 能给 S 授权;
但他的 `orgScope` 只有「后端组」这一支,所以**只能授权给后端组里的人**。
部长的 `orgScope` 是整个技术部,所以部长能往技术部任何位置授权。
**范围自下而上自然放大,不需要单独维护「谁的权限更大」。**

### 5.3 能力对照

| 动作 | 谁能做 |
|---|---|
| 浏览任意节点 | 所有登录用户(受限节点除外,见 §5.6) |
| 发表 / 回复评论 | 所有登录用户 |
| 删除评论 | 评论作者本人,或该节点的任一祖先所有者 |
| **改**别人的评论 | **没人能改** —— 只有作者本人 |
| 在二级节点下新建页面 | 在该节点上 `canEdit` 的人;**组员可在自己所属的节点下新建** |
| 编辑正文 / 改标题 | `canEdit` |
| 移动 / 同级排序 | `canEdit` |
| **删除节点**(物理删除整棵子树,不可恢复) | **祖先链所有者**(`canManage`)—— 被授权者能改,但不能销毁 |
| 授权 / 收回(增删名单) | `canManage`,且被授权者须在操作者组织范围内 |
| 管理可见范围(读者名单) | **该节点的创建者或所有者**(上级所有者**不能**代为管理) |
| 任命 / 变更二级节点的所有者 | 该节点的祖先所有者(即部长) |
| 维护组织架构(建部门 / 导人员 / 设归属) | `is_super_admin` |
| 查看审计日志 | 祖先链所有者,或 `is_super_admin` |

> ⚠️ **删除的门槛高于编辑。** 被授权者能改、能建,但不能**销毁**;
> 删除已经是不可逆操作,所以它归所有者,不归被授权者。

> ⚠️ **改评论与删评论是两件事。** 所有者能删别人的评论(版务),但**不能改**(篡改他人言论)。
> 两者曾经共用一个标志位,表现是「所有者看得到编辑按钮、点了却 403」。

---
## 6. 接口

### 6.1 通用约定

- 前缀 `/api/v1`,全部返回 JSON。
- 认证:HttpOnly Cookie 承载**不透明会话 id**,不用 localStorage 存 token。
- 错误体统一:

```json
{ "error": { "code": "FORBIDDEN", "message": "你没有编辑该节点的权限" } }
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登录或会话过期 |
| `FORBIDDEN` | 403 | 已登录,但对这个资源没有该操作的权限 |
| `NOT_FOUND` | 404 | 资源不存在,**或读不到**(见下) |
| `VALIDATION_FAILED` | 400 | 参数校验失败 |
| `VERSION_CONFLICT` | 409 | 乐观锁冲突,客户端需重新拉取 |
| `RATE_LIMITED` | 429 | 触发限流(§6.1.3) |

> ⚠️ **`NOT_FOUND` 有两种含义,不要「统一」掉这个区分。**
> 读路径上「存在但读不到」一律回 **404** —— 403 等于承认这里有个你看不见的东西(§5.6);
> 写路径上被拒一律回 **403** —— 你看得见它,只是改不了,这个信息对用户更有用。

- **请求体上限 8MB**(`app-setup.ts` 的 `BODY_LIMIT`)。
  Express 的 JSON 解析器默认只有 100kb,而正文上限是 2MB —— 不抬高的话长文档保存会被
  body-parser 直接拒掉,表现成「短文档正常、长文档存不进去」。
- body-parser 的解析错误**不是** `HttpException` 的子类,异常过滤器必须显式识别,
  否则「请求体过大」会变成 500 —— 而它明明是客户端的问题。
- 分页:评论、审计日志、人员列表用游标分页(`?cursor=&limit=`)。
  人员列表返回 `{ users, total, nextCursor }` —— **带 `total`** 是刻意的:
  以前直接返回数组,全公司 320 人时管理员只看到前 200 个,而界面上没有任何迹象。

### 6.1.1 会话机制

- 会话 id 是**不透明随机串**,服务端存 **SHA-256 哈希**,库里没有明文。
- Cookie 属性:`HttpOnly` + `SameSite=Lax` + `Secure`(由 `SESSION_COOKIE_SECURE` 控制)。
- 默认有效期 720 小时(`SESSION_TTL_HOURS`,默认 24 × 30)。
- 过期会话由定时任务清理(6 小时一次)。
- **守卫每次请求都查一次 `users.status`**,所以停用/离职能立刻生效;
  改状态时还会主动删掉该用户的全部会话行(§9.3)。

### 6.1.2 密码策略与首次登录改密

- 密码用 **bcrypt,cost 12**。
- 初始密码统一 `123456`,新账号一律带 `must_change_password=true`。

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
- **`SESSION_SECRET` 没有默认值**,部署时必须显式配置;为空时首登改密**不降级放行**,而是明确报错 ——
  降级会让这条链路静默失效,那是更坏的结果。
- ⚠️ 已知风险(写在这里,不藏):凭证是**无状态**的,改密成功后服务端不记录"已用过",
  因此理论上在有效期内可以重放。它只在"未改密"这个极短窗口内有意义,且需要先拿到密码。

### 6.1.3 登录限流与锁定

**两道门,按账号与按 IP 分别计数。**

| 维度 | 计数键 | 阈值 | 窗口 / 锁定时长 |
|---|---|---|---|
| 账号 | `kc:login:fail:u:{工号}` | 5 次 | 15 分钟 |
| 出口 IP | `kc:login:fail:ip:{ip}` | 100 次 | 15 分钟 |

锁定期间**不校验密码** —— 否则锁了照样能拿密码去撞,锁定形同虚设。
被锁时返回 `RATE_LIMITED`(429),错误体里带 `retryAfterSeconds`。

**四条刻意的设计,每条都对应一种写错就静默失效的情形:**

1. **限流检查放在 bcrypt 之前。** 密码哈希是这里最贵的一步(故意贵),
   放在它后面等于让攻击者用一次请求换一次 hash。
2. **锁定键按「工号」计数,包括不存在的工号。**
   若只对真实账号计数,攻击者就能靠「哪些工号会被锁」**枚举出公司有哪些人**。
   现在无论工号是否存在,失败都计数、都返回同一个错误体。
3. **IP 那道门只统计失败,且成功不清 IP 计数。** 一个出口 IP 是多人共用的,
   某个人登录成功不代表那个 IP 上的撒网行为已经停止。
   而账号那道门在**登录成功时会清零** —— 正常人打错几次不该被一路锁下去。
4. **计数只在第一次失败时设过期。** 每次都续期的话,持续攻击会让计数**永不过期**,
   把真实用户一起永久锁住。

⚠️ **Redis 挂了会怎样:锁定失效(退回无限尝试),系统其他部分照常。**

这是刻意的取舍。限流是「防爆破」的加固,不是「身份正确性」的一部分;
让登录在 Redis 故障时**完全不可用**的代价(全员登不进)远大于「这段时间少一道门」。

**审计:** 只有**真实存在**的账号被锁时才写 `auth.login.locked` ——
不存在的工号也写的话,审计日志会被攻击者用无关工号灌满。

### 6.2 接口清单

<!-- BEGIN GENERATED:routes -->
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
| GET | `/comment-counts` | `comment/comment.controller.ts` |
| DELETE | `/comments/:commentId` | `comment/comment.controller.ts` |
| PATCH | `/comments/:commentId` | `comment/comment.controller.ts` |
| GET | `/health/ready` | `health/health.controller.ts` |
| GET | `/health` | `health/health.controller.ts` |
| GET | `/nodes/:nodeId/comments` | `comment/comment.controller.ts` |
| POST | `/nodes/:nodeId/comments` | `comment/comment.controller.ts` |
| GET | `/nodes/:nodeId/content` | `node/node.controller.ts` |
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
<!-- END GENERATED:routes -->

### 6.3 几个容易看错的细节

- **`GET /nodes/:id/export` 必须带 `?format=md`**。合法取值只有 `md`(见 `EXPORT_FORMATS`);
  传别的值回 400,而且**参数校验先于权限校验** —— 所以对它传错格式时看到的是 400 而不是 404,这是正常的。
- **`POST /nodes/bulk/move` 的路径写作 `nodes/bulk/move`**,而且**注册在 `nodes/:nodeId/...` 之前**。
  Express 按注册顺序匹配,否则 `bulk` 会被当成一个 nodeId、被 `ParseUUIDPipe` 以 400 拒掉。
- **`GET /audit-logs/export` 返回 `text/csv`**,不是 JSON;文件名走 RFC 5987 编码;带 UTF-8 BOM(Excel 不乱码)。
- **`DELETE /nodes/:id` 是物理删除**,删除整棵子树,不可恢复(§8.2)。
- **`GET /health` 不碰外部依赖**,`GET /health/ready` 才会检查数据库与 Redis。两个探针的用途不同:
  前者用于容器存活探针(数据库没起来时不该把 api 反复重启)。

### 6.4 审计游标为什么必须校验

游标对外是**字符串**(审计主键是 `BigInt`,JSON 装不下 64 位整数)。
原实现把它原样拼进 `::bigint`,于是 `?cursor=abc` 会让 PostgreSQL 抛 22P02,
再被全局过滤器兜成 **500 INTERNAL_ERROR** —— 一个纯客户端的参数错误显示成「服务器内部错误」,
任何登录用户都能触发,还在日志里留下假的故障记录。

现在 `normalizeCursor` 只接受 `^[0-9]{1,19}$`(19 位是 signed 64-bit 的十进制上限),其余一律 400。

---
## 7. 前端

### 7.1 路由与页面

<!-- BEGIN GENERATED:pages -->
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
<!-- END GENERATED:pages -->

除 `/setup`、`/login`、`/change-password` 外,其余页面都在 `AppLayout` 里(顶栏 + 左树 + 主区)。
`/admin/*` 外面包了一层 `RequireSuperAdmin` —— 它**只负责体验**(手工敲地址时看到一句人话而不是满屏 403),
判权始终在服务端。

左侧是**完整的组织与内容树**(按可见性过滤后),主区是编辑器,右侧是上下文面板(目录 · 评论)。

### 7.2 状态管理

- **服务端状态**:TanStack Query(缓存、失效、重试都交给它)。
  ⚠️ 树的 `editableNodeIds` 是服务端算的,所以**改完必须失效重取**,不要在本地推导 ——
  本地推不出来(祖先链变了会连带影响判定)。
- **客户端状态**:Zustand。
- **个人视图**(最近浏览 / 收藏 / 检索历史)**只存 localStorage**,刻意不落库:
  这是「我的顺手」,不是「公司的事实」—— 落库就要有接口、有权限判定、有清理策略,
  而它带来的产品价值并不值得这些。
  ⚠️ 读写两侧都包了 `try/catch`:无痕模式/策略禁止时 localStorage 会直接抛,
  不能让它把整个工作台带崩。
  ⚠️ 展示前要**按组织树过滤**:节点可能已被删除,也可能被设成受限而当前用户不在名单里 ——
  直接渲染本地列表就会把一个他已经无权看见的标题摆在他面前。

### 7.3 字号与排版刻度

四档,与 Tailwind 具名档一一对应,**不允许任何任意值字号**:

| 用途 | 字号 | Tailwind |
|---|---|---|
| 正文 | 16px | `text-base` |
| 标题 | 24px | `text-2xl` |
| 界面文字 / 树行 / 评论 | 14px | `text-sm` |
| 辅助说明(下限) | 12px | `text-xs` |

参照的是 Atlassian Design System(Confluence 用的就是它)与 Ant Design 的公开规范。
**12px 是下限**,再小在内网的老显示器上读不清。

另外两条下限:

- **点击目标 ≥ 24px**(键盘与触屏可点)。
- **对比度 ≥ 4.5:1**(WCAG AA)。
  ⚠️ `text-slate-400` 在浅背景上只有 **2.56:1**,已在全部界面文字上换成 `slate-500`。
  这一条是**量出来的**,不是看出来的 —— 我第一次测量得出的结论还是错的。

### 7.4 编辑器

Tiptap 3,内容以 **ProseMirror JSON** 存库(`node_contents.content_json`)。

- **工具栏**:标题、列表、代码块(带语言高亮)、图片、表格(行列增删)、引用、链接气泡。
- **图片**:每页最多 **10 个**(`MAX_IMAGES_PER_NODE`,服务端强制),工具栏显示剩余额度。
- **乐观锁**:保存时带 `baseUpdatedAt`;服务端发现已被别人改过就回 409,前端提示重新加载。
  ⚠️ 无法解析的 `baseUpdatedAt` 按校验错误处理,而不是"当成没传"——
  后者会让乐观锁在最需要它的时候静默失效。

### 7.5 保存与数据安全

⚠️ **这一节记录一个真实的 P0 事故。**

编辑器曾经只在"点保存"和"定时器触发"时写库。实测:在文档里输入后 **250ms** 内切走页面,
**零个写请求发出** —— 输入的内容直接没了,而界面上没有任何提示。

现在三条路都兜住:

1. **组件卸载时保存**(`useEffect` 的清理函数里真的发请求,不是"只清定时器")。
2. **`beforeunload`** 时用 `navigator.sendBeacon` 发一次(它能在页面卸载后送达),
   并给出离开确认提示。
3. 常规的防抖保存。

> **教训不是"记得加保存",是"只在定时器里保存"这种设计本身就有一个静默的丢失窗口。**

### 7.6 其余界面能力

| 能力 | 说明 |
|---|---|
| `Modal` | `role=dialog` + `aria-modal`;焦点移入与还原;Tab 循环不逃逸;Esc 关闭(挂 document 捕获阶段);锁 body 滚动 |
| `Toast` | 常驻的 `aria-live=polite` 容器(每次新建的话读屏不会念);错误用 `role=alert`,成功 4 秒、失败 8 秒 |
| `ErrorBoundary` | 渲染期抛错时显示可读页面,而不是整片白屏 |
| `Skeleton` | 加载占位,`role=status` + `aria-hidden`(读屏念「正在加载」),避免布局跳变 |
| `ErrorNote` | 失败时给**「重试」按钮**,不只是显示一句红字 |
| 树键盘导航 | ↑↓ 走可见顺序;→ 展开/进子节点;← 折叠/回父节点;Home/End;Enter 打开 |
| 打印 / PDF | `window.print()` + `@media print`;隐藏顶栏侧栏,只留正文。**零新依赖** |
| 检索高亮 | 命中词用 `<mark>`;切分函数满足「拼回去 === 原文」的固定不变式 |

> **为什么导出 PDF 走浏览器而不是服务端:** 服务端生成要引入一整条渲染链(无头浏览器或 PDF 库),
> 在**内网离线**环境里既加体积又加维护面,而用户要的只是「能打出来 / 能存成 PDF」。
> 浏览器自带的打印对话框正好提供这两件事,且中文字体用系统字体(不会缺字)。
> 这是**明确取舍**,写在这里以免以后有人顺手补上服务端 PDF。

### 7.7 无障碍

- 全局 `:focus-visible` 焦点圈;`.kc-prose { overflow-wrap: anywhere }`(长链接与长英文不撑破布局)。
- 树是 `role=treeitem` + `aria-expanded` / `aria-level` + roving tabindex。
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

**三条必须记住的:**

1. **防环**:目标不能是自己或自己的子孙。判据用**物化路径前缀** —— 比递归查子孙便宜,而且不可能漏。
2. **目标父节点也要 `canEdit`**。否则可以把节点「搬进」一个自己无权动的分支。
3. ⚠️ **必须用 `substr(x, $n::int)`,不能写 `substring(x from $n)`。**
   PostgreSQL 里 `substring(string from pattern)` 是 POSIX 正则那一种,
   当参数类型是 `unknown`(Prisma 的 `$executeRaw` 就是这么发的)时会被解析到
   **正则分支,结果静默返回 NULL** —— 若路径列可空,这会把整棵子树的路径悄悄清掉,而不报任何错。

位置用 `makeRoomAt` 实现:把该位置及之后的兄弟整体后移一位。
⚠️ 它必须 `excludeId` —— 被移动的节点此刻**还挂在原位置**,不排除的话它会被自己挤走一位,拖拽结果偏一格。

### 8.2 删除(物理删除,不可恢复)

**没有回收站,没有保留策略。** 删除就是立即、不可恢复的物理删除,**整棵子树一起删**。

顺序是刻意的:**按深度从叶子往根删**,不是靠数据库的级联。
理由是级联删除的报错信息很难定位(只说"外键冲突"),而逐层删能明确报出是哪一层出的问题。

**删除的门槛是 `canManage`(祖先链所有者),不是 `canEdit`。**
被授权者能改、能建,但不能**销毁** —— 删除不可逆之后,「能改」与「能销毁」必须分开。

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
永远搜不到,哪怕标题完全匹配 —— 表现是「我明明建了个叫『市场部』的组,搜『市场部』却没有它」。
`COALESCE` 同样不能省:LEFT JOIN 未命中时该列是 NULL,而 `NULL ILIKE …` 求值为 NULL(不是 false),整行会被 WHERE 丢掉。

**② 权限过滤写在代码里,不写进 SQL。** 命中已被 `LIMIT 20` 收窄,这里最多 20 次判定;
而在 SQL 里再写一遍「祖先链 + 读者名单」的判定,等于**把安全逻辑实现第二遍**,
那份迟早与 `permission.ts` 分叉 —— 而分叉的表现是静默越权。

> ⚠️ **检索是最容易漏的一条读取路径。** 树、详情、导出、评论都挡住了,却忘了检索的话,
> 受限文档的**标题与正文片段会直接出现在全公司的搜索结果里**,而保密功能看起来完全正常。

排序与中文方案的原理见 §2.3。

### 8.4 组织架构导入(Excel)

```
GET  /admin/org/import-template   → 下载 .xlsx(带当前全部人员与节点)
       在 Excel 里改
POST /admin/org/import?dryRun=1   → 上传,只返回差异预览,不写库
POST /admin/org/import            → 确认写入(一次事务)
```

**第二步与第三步是同一个接口的两个模式**,不是两个接口。服务端只有一份解析与差异计算逻辑,
`dryRun` 只是「算完不提交」。这样预览里看到的与真正写进去的必然一致 ——
若拆成两套代码,两边迟早算出不同结果,而管理员是**照着预览做决定**的。

增量语义:

| 表格里的情况 | 处理 |
|---|---|
| 工号不存在 | 新建(`status=active`,初始密码 `123456`,`must_change_password=true`) |
| 工号已存在 | 不新建;按需要补上归属 |
| 工号已存在但姓名不同 | 以表格为准**更新姓名** |
| 归属已存在 | 跳过(**幂等**) |
| 归属不存在 | 新增一条归属 |
| 表格里**没出现**的人 | **完全不动** —— 不删、不停用、不改他的归属 |

> 因此:同一份表格上传第二遍、第三遍都不会重复建号,可以放心反复上传。

⚠️ **已知限制:「把人从某个组移出去」做不到。** 增量语义下,「表格里没写」与「要删掉这条归属」
**无法区分**。所以界面上必须有「节点成员」入口作为配套 —— 少了它,调岗只有一半路径走得通。

模板必须有**两列 ID**(`部门ID(勿改)` + `组ID(勿改)`):一列只能标识「最深那个节点」,
遇到「组是新建的 + 部门刚改名」时仍会重复建部门。

两条实现要点:

- **权限检查必须在文件校验之前。** 反过来的话,普通成员不带文件请求会先撞上「请选择文件」的 400 ——
  等于确认了「这个接口存在」。权限不足就该一律 403。
- **解析与写库共用同一份纯逻辑**(`org/import.core.ts`)。预览与确认走同一份代码,
  否则两边迟早算出不同结果,而管理员是照着预览做决定的。

### 8.5 批量移动

`POST /nodes/bulk/move`,body 为 `{ nodeIds, newParentId }`,一次最多 **50** 个。

**只做移动,不做批量删除。** 移动可逆(再移回去就行),而删除不可恢复 ——
两者的风险差一个量级,不该共用一个入口。真要清理一整块旧内容,删那个组本身就够了。

三条为了「结果可预测」而加的限制:

| 限制 | 漏了会怎样 |
|---|---|
| 不能移到**它自己或它的子孙**下 | 物化路径变成自引用,之后前缀查询既找不到祖先、又把自己算成自己的后代 —— 而**权限判定也走物化路径**,会被一起带偏 |
| 批量里**不允许互为祖先** | 选了 A 又选它里面的 B 时,结果取决于执行顺序:先移 A 把 B 一起带走,再移 B 又把它拽出来。**直接拒绝比猜用户想要什么清楚** |
| 校验**全部通过才写**,一个事务里全做或全不做 | 不做「部分成功 + 失败清单」—— 那会留下一个用户没预期过的中间状态,而他要自己去核对哪几个动了 |

位置一律**追加到目标末尾**。让每个节点都能指定位置的话,用户要在脑子里模拟一次完整的排序,而那是拖拽该做的事。

**权限:逐节点 `requireEdit`,目标也要 `requireEdit`。** 不做任何「选了一批就一起放行」的捷径。

> ⚠️ 实现上有一处是刻意的:**单节点移动的写入抽成了 `applyMoveTo()`,两个入口共用同一份路径重写。**
> 抄一份出来的代价是某天有人只修了其中一份,而物化路径写错的表现是「某棵子树的祖先链错了」——**不报任何错**。

前端入口在节点页(只在组 / 部门上出现),是个**弹窗**而不是树上多选:
树上多选要改 `OrgTreePanel`(承载着整套键盘导航与 ARIA),为一个低频操作去动它风险与收益不成比例。
两处把服务端规则**提前变成界面语言**:

1. 选了 A 又选它里面的 B 时,弹窗**明说**「『X』不会单独移动 —— 它已经在『Y』里面了」,
   而不是等提交后被服务端打回。被去掉的每一条都带原因显示 ——
   **静默缩小用户的选择是最糟的处理方式**(他会以为系统自作主张)。
2. 目标下拉里**不出现**选中项自己与它的子孙 —— 那些目标必然成环、必然被拒。
   让用户能选中一个注定失败的目标,等于把错误推到最后一步才告诉他。

### 8.6 成员与授权是两件事

它们看起来都在回答「这个节点上都有谁」,共享一个入口位置与一套候选人过滤,
合并成一个带 Tab 的弹窗能省一半代码。但**没有合并**,因为混在一起会让
「移出成员 = 收回权限」变成一种反复出现的误解:

- 移出归属**不改变所有权**:被移出的组长仍然是组长,该能改的还是能改;
- 但**会缩小他的组织范围**:他能授权给别人的人变少了;若是他最后一条归属,
  他将不能在别人下面新建、也不能被授权。

这两句写在移出前的确认框里,而且有单测钉住 —— 它们是这件事的安全边界,
漏了或写反了会让人照着错误的心智模型做人事调整。

---
## 9. 运维

### 9.1 配置项

<!-- BEGIN GENERATED:env -->
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
| `WEB_ORIGIN` | `process.env.WEB_ORIGIN ?? 'http://localhost:5173'` |

共 **14** 个。由 `scripts/gen-doc.mjs` 从 `configuration.ts` 生成;与 `.env.example` 的双向比对由 `pnpm audit:docs` 负责。
<!-- END GENERATED:env -->

对应地,`.env.example` 声明了部署时需要填的键。两者的**双向比对**由 `pnpm audit:docs` 负责:
代码读了但 `.env.example` 没声明的会报,反之也报。

### 9.2 常用命令

```bash
docker compose up -d --build        # 起/更新四个容器(迁移会自动应用)
pnpm verify:org                     # 端到端验收(168 项,跑之前先 seed:dev)
pnpm db:verify                      # 数据库契约自检(表 / 索引 / CHECK / v1 残留)
pnpm seed:dev                       # 演示数据(**需要先清库**,不做幂等)
pnpm check                          # typecheck + lint + test + audit:docs
```

⚠️ **在容器里跑验收脚本时必须带 `-e KC_API`**:

```bash
docker compose exec -T -e KC_API=http://web/api/v1 -e KC_ROOT=http://web \
  api node scripts/verify-org.mjs
```

脚本默认打 `http://127.0.0.1:8080`,而在 **api 容器内部** `127.0.0.1` 是它自己的回环,
那里没有任何东西在 8080 上监听 —— 表现是 `ECONNREFUSED`,看起来像服务挂了。
指向 `http://web/api/v1` 走的是 nginx,也就是**浏览器那条路径**,反而更接近真实。

### 9.3 账号与登录

- **工号 + 密码**登录。新账号初始密码统一 `123456`,首次登录强制改密(§6.1.2)。
- **管理员重置密码**:`POST /admin/users/:id/reset-password`。
  它会做三件事,少一件都会留下说不清的状态:①密码重置回 `123456`;
  ②置 `must_change_password`;③**吊销该用户全部会话**(「重置」在管理员认知里就是「我把他踢出去了」)。
  两条刻意的拒绝:
  - **不能重置自己**(你现在是登录状态,要改自己的密码请走「修改密码」;允许它只会制造一次手滑);
  - **不能重置一个登不进来的人**(已离职/停用)→ 明确报错并说明要先改回在职,
    而不是"重置了但他还是登不上"。
- **改状态会立刻踢下线**:改成停用或离职时,服务端会删掉该用户全部会话行。
  ⚠️ 界面上必须**先告知**再做 —— 「这个人会被立刻踢下线」。
- **不能把最后一个在职管理员停用 / 离职。** 那会把系统锁死,而且**没有界面能改回来**。
  同理,权限不能授给已停用或已离职的账号。

### 9.4 登录被锁了怎么办

**同一个工号连续输错 5 次密码,锁 15 分钟;锁定期内即使密码正确也登不进去。**
这是刻意的(防爆破),但它是**唯一一个会让正常用户「明明密码对却进不去」的机制**,
必须在培训里说明,否则运维会收到「系统坏了」的报障。

```bash
# a) 等 15 分钟(锁会自动过期,不需要任何操作)

# b) 立刻解锁某一个工号:
docker compose exec -T redis redis-cli del kc:login:lock:u:kc004
```

> ⚠️ **Redis 挂了的时候锁定会失效(退回无限尝试),这是刻意的取舍**(§6.1.3)。
> 把 `LOGIN_MAX_ATTEMPTS` 设为 `0` 可以关掉账号那道门(IP 门仍然生效)。

### 9.5 备份

`scripts/backup.sh` 备份到 `./backups/<时间戳>/`,`scripts/restore-drill.sh` 做恢复演练
(恢复到临时库并逐表比对行数,**不动生产库**)。

> ⚠️ **已知风险:备份与数据同盘。** 该盘整体故障时数据与备份会一起丢。
> 这是用户已知悉并接受的风险,写在这里是为了后来的人不要以为「有备份脚本就安全了」。

### 9.6 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录成功但刷新后回到登录页 | `SESSION_COOKIE_SECURE=true` 却在用 http 访问 | 改成 `false` 后 `docker compose up -d` |
| api 容器反复重启 | 数据库没起来 / 密码不对 | `docker compose logs api`,核对 `.env` 的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` |
| 页面能开、接口 502 | api 未 ready | `docker compose ps` 看 api 是否 healthy;`logs api` 找 `migrate deploy` 是否失败 |
| 图片 404 | web 容器没挂到 uploads 卷 | `docker compose config` 看 web 的 volumes 里有没有 `uploads:/data/uploads:ro` |
| 中文搜索搜不到 | `pg_trgm` 扩展或三元组索引丢失 | `psql -c "\dx"` 确认扩展;`pnpm db:verify` 会检查 |
| **有人密码明明是对的却登不进去** | 连续输错 5 次触发了登录锁定 | 等 15 分钟,或按 §9.4 解锁。**先查这一条** |
| **有人看不到某篇文档** | 节点被设成**受限**,而他不在读者名单里 | 让该节点的创建者或所有者打开「可见范围」把人加进去 |
| **有人误删了文档** | 删除是物理删除,没有回收站 | **无法恢复**,只能从备份找。查是谁删的:`/audit` 搜 `node.delete` |
| 某人不在某个组的成员列表里 | 他的归属被移出,或本来就没加过 | 节点成员弹窗能查「这个节点下都有谁」;调岗是**两步**:先加入新节点,再从原节点移出 |

---

## 10. 为阶段二预留的硬约束

以下是为「实时协同 / 通知中心」预留的,**现在不做,但现在就不能破坏**:

1. 评论表预留 `anchor_type` / `anchor_text` / `anchor_pos` 三列的位置(行内锚定用)。
2. `SESSION_SECRET` 留给协同网关签短期 JWT 的用途(现在被首登改密借用)。
3. Redis 已开 appendonly(阶段二放"在线态"与队列)。
4. 附件走 `UPLOAD_DIR` 抽象,**不要**在业务代码里拼本地路径 —— 阶段二可能换 MinIO。
5. 审计日志的 `detail` 是 JSONB,新动作往里加字段不需迁移。
6. 所有时间列都是 `timestamptz`,不存本地时间。

---

## 11. 风险与开放问题

### 11.1 已知风险(接受并留档)

- **备份与数据同盘**:见 §9.5。用户已知悉。
- **一次性凭证无状态**:见 §6.1.2。窗口极短,但理论上可重放。
- **Redis 故障时限流失效**:见 §6.1.3。刻意取舍。
- **删除不可恢复**:见 §8.2。已要求提前告知使用者。

### 11.2 技术风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 单机部署无冗余 | 本地卷存附件,机器坏了附件就没了 | 备份脚本 + 异地保存;附件目录单独挂盘 |
| 大文档编辑器性能 | 几千行的页面,Tiptap 首次渲染会卡 | 阶段一可接受;必要时引入分块加载 |
| `pg_trgm` 检索精度 | 对长文档的相关度排序不如专业搜索引擎 | 阶段一数据量下无虞;**上量后必须换 Meilisearch** |
| 前端组件测试缺失 | 未安装 jsdom / testing-library,组件渲染没有自动化覆盖 | 把值得测的逻辑**抽成纯函数**再测(树导航 / 个人列表 / 高亮 / 批量移动选择);组件本身仍靠人工验收 |

### 11.3 仍然开放

- **是否需要「仅创建者可见的草稿」这一状态。** 数据模型里 `draft` 是合法取值
  (`NODE_STATUSES`),但没有接口会设置它 —— 现状等于未启用。
  ⚠️ 注意它与 `visibility=restricted` 不是一回事:前者是**生命周期**,后者是**访问范围**。
- **移动端**:阶段一完全不做,但要先确认「同事会不会真的在手机上查文档」。
- **附件的孤儿文件**:上传了但没插进文档的图片不会被回收。清理需要引用计数,阶段一不处理。
- **重置密码后通知本人**:需要通知中心,属阶段二。

---

## 12. 开发约定

- **注释写「为什么」,不写「做了什么」。** 代码已经说明做了什么。
- **凡是写数据的逻辑,只允许存在一份。** 抄一份出来的代价是某天有人只修了其中一份。
- **不要重排章节号** —— 代码注释里引用了它们(§0.4)。
- **不要手改生成块**(§0.1)。改代码后跑 `node scripts/gen-doc.mjs`。
- **新增读取路径时,把它加进 `verify-org` 的侧信道断言里**,而不是只加进 §5.6 那张表。
- 提交前跑 `pnpm check`(typecheck + lint + test + audit:docs)。

---

## 附:变更记录

> 这份文档只记录**当前状态**。历史变更在 git 里。
> 下面这张表存在的唯一理由,是让 `audit:docs` 能校验「文档头版本 = 最新一行」
> (防止有人改了内容却忘了改版本号)。

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-27 | v3.0 | **依据实际代码整体重写。** 旧版本 2500 行里大半是历史变更记录与 v1.x 里程碑快照,而**历史与现状混在一起**正是它不可信的原因之一 —— 那些内容已整体删除。新版本的接口 / 数据模型 / 环境变量 / 前端路由四张表**由 `scripts/gen-doc.mjs` 从代码生成**,并由 `pnpm audit:docs` 校验一致性;文档与代码脱节会让门禁失败,而不是靠人去发现。 |

