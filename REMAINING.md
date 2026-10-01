# 知源 KnowledgeCool · 未完成工作交接（2026-10-01）

> ⚠️ **这份文件是 §0.3「全仓库只留一篇文档」的唯一显式例外，而且是有意的。**
>
> 它不是设计文档，而是一份**临时的工作交接清单**（还剩什么没做），**做完即删**。
> 破例放进仓库的原因是：开发机是**网吧机器**，桌面与 `%TEMP%` 会被还原 ——
> 放在仓库外，第二天就没了；而这份清单必须能被接续的人看到。
>
> 例外在两处**显式登记了理由**，不是默许：
>
> - `scripts/audit-docs.mjs` 第 10 项检查的 `EXTRA_DOCS` 名单
> - `DESIGN.md` §0.3
>
> **"默认不允许"这条规则本身没有变**：默默多出第二篇 `.md`，`pnpm audit:docs` 照样会红。
> 做完 §2 之后请删除本文件，并把上面两处登记一起去掉。

---

## 0. 先读这一段（两条硬性提醒）

### 0.1 这一轮的工作**已经提交并推送**

```
仓库：C:\Users\Administrator\Desktop\knowledgeCool
分支：main
起点：5bd09f4「加上定时备份…」
本轮：环境配置 + 全面代码质量审查 + 4 轮串行复核 + 3 个并行复核 + 复核后的修复
      全部改动已作为一个提交推到 origin/main
```

也就是说 **它是可恢复的** —— 工作区万一被弄乱，`git log` 找得到、`git checkout <文件>` 取得回、
远端也有一份。但**在这之后**新产生的改动默认仍未提交，动 git 之前先看清状态：

```powershell
cd C:\Users\Administrator\Desktop\knowledgeCool
git log --oneline -5
git status --short
git stash list
```

**不要**在看不清状态时跑 `git checkout .` / `git restore .` / `git clean -fd` / `git reset --hard` ——
那会把**尚未提交**的改动抹掉（本轮之前的那些已经在远端了，丢不了）。

⚠️ 另外：这台机器的**桌面与 `%TEMP%` 会被还原**（网吧机器）。所以
「跑一次脚本看输出」这类需要留存的东西，**别只留在临时目录里**，要么写进仓库，要么写进本文件。

### 0.2 环境是两个坑（不按这个来会得到假的报错）

1. **Node 不在默认 PATH 里给老进程用**。桌面那份 Node 已加进**机器级 PATH**，但**已经在运行的进程**（资源管理器 / 已开的终端）读到的还是旧 PATH。每个新开的 PowerShell 里先跑：

   ```powershell
   $env:Path = "$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
   ```

   Node v24.17.0 · npm 11.13.0（镜像已设为 `https://registry.npmmirror.com`）· pnpm 12.6.0（corepack 激活）

2. **这台机器是 Windows PowerShell 5.1**，`Get-Content` 默认按 ANSI 码页读，会把仓库里的中文**显示成乱码**（文件本身没问题）。
   - 读文件用编辑器的 read 工具，或 `Get-Content -Encoding UTF8`
   - **不要**用 `node -e "…"` 写含反引号或 `$` 的脚本 —— PowerShell 会把它们吃掉（本次踩了 4 次）。要临时脚本就写个 `.mjs` 到 `%TEMP%` 再 `node <路径>`

3. 这台是**网吧机器，网络很慢/不稳**。不要随手 `pnpm install`（上次装了 7 分 10 秒，且大量连接被重置）。依赖已经装好，直接用。

### 0.3 交付前必须过的门

```powershell
cd C:\Users\Administrator\Desktop\knowledgeCool
$env:Path = "$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
pnpm check     # typecheck + lint + format:check + audit:docs(12 项机检)
pnpm build     # nest build + vite build
```

当前状态：**两个都是 EXIT 0**。`format:check` 与 `audit:docs` 都在 `check` 里，别只跑 `pnpm lint` 就以为过了。

`pnpm typecheck` 会**先构建 `packages/shared`**（两个 app 经包入口 `dist/` 引用它）；这个顺序写在 `package.json` 里，别拆开。
另外 `pnpm verify:doc` / `pnpm verify:org` / `pnpm db:verify` **需要跑起来的栈**（库 + Redis + nginx），离线跑不了，不是坏了。

---

## 1. 这一轮已经做完的（都已验证，勿重复劳动）

### 环境（第一部分需求）

- 桌面 Node v24.17.0 加入**机器级 PATH**；npm 镜像设为 `https://registry.npmmirror.com`（写在 `C:\Users\Administrator\.npmrc`）
- 补做了两件必须做的事：PowerShell 执行策略 `CurrentUser = RemoteSigned`（否则 `npm` 走 `.ps1` 被拦）；`corepack enable` + `pnpm@12.6.0`
- 已广播 `WM_SETTINGCHANGE`（**仍需重启已开的终端**才看得到新 PATH）

### 缺陷修复

| #   | 位置                            | 问题                                                                                                          | 状态                                                                     |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| H1  | `package.json`                  | `pnpm typecheck` 干净检出必挂（200+ TS2307，shared 的 dist 还没构建）                                         | ✅ 已修，已用"删 dist 再跑"证明                                          |
| H2  | `apps/api/src/app-setup.ts`     | 反向代理后 `request.ip` 恒为 Nginx 地址 → IP 限流退化成"全公司一个桶"、审计 IP 全失真                         | ✅ 已修（`trust proxy = 1`）                                             |
| —   | `DESIGN.md` §5.3                | 读者名单门槛与代码相反（你已确认"上级所有者能管"是对的）                                                      | ✅ 改文档                                                                |
| M1  | `pnpm check`                    | `format:check` 未纳入门禁，58 个文件早已漂移                                                                  | ✅ 已修 + 已格式化                                                       |
| M2  | `packages/shared/src/audit.ts`  | `auth.login.locked` 有记录却不在 `AUDIT_ACTIONS`（筛不出来、无标签）                                          | ✅ 已修                                                                  |
| M3  | `scripts/audit-docs.mjs`        | 接口区切片终点标题写错 → `indexOf` 返 -1 → 切片静默变成全文 61.5%                                             | ✅ 已修（改按**标题行**锚定 + 结构性不变式）                             |
| M4  | `DESIGN.md` §8.4                | 导入写入步骤写反（不带参数其实是**预览**）                                                                    | ✅ 已修（这是第二次才修对，见 §5.6）                                     |
| —   | `scripts/gen-doc.mjs`           | 生成块与 Prettier 互相冲突（一次 format 就让 `--check` 失败 250 行）                                          | ✅ 已修（生成器自己写 `prettier-ignore-start/end`）                      |
| —   | `apps/api/scripts/seed-dev.mjs` | 脚本是坏的：v2.4 之前的首登流程 + 切身份不清 cookie（拿超管会话冒充别人）                                     | ✅ 已修（改 `initial-password` 流程 + 每次清 cookie + 严格断言会话建立） |
| —   | `.github/workflows/ci.yml`      | 仓库**从来没有 CI**                                                                                           | ✅ 已补（Node 22/24 双档，与本地同一套命令）                             |
| —   | `.github/workflows/ci.yml`      | `pnpm db:verify` 只在 `apps/api` 里有，文档教的却是在根目录跑                                                 | ✅ 已补根级别名                                                          |
| —   | 多处                            | `verify-db.mjs` 漏检 `node_readers` 与 `nodes_visibility_check`（丢了这两样保密功能整个失效而自检仍报"通过"） | ✅ 已补                                                                  |
| —   | 多处注释                        | 15 处把**导入**引成 §8.5（实为 §8.4）、6 处把**评论**引成 §8.4（实为 §5.4）、一批指向已废弃的 `M1~M6` 里程碑  | ✅ 已修                                                                  |
| —   | 清理                            | 删掉 2 个孤立脚本、`@nestjs/testing`、`ts-jest` 白名单条目、一批不实注释                                      | ✅                                                                       |

### 本轮（并行复核之后）新修

| 严重度      | 位置                                                   | 问题                                                                                                                                                                                                 | 状态                                                                           |
| ----------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 🔴 Critical | `apps/api/src/org/import.service.ts`                   | **Excel 导入把物化路径写成"一级节点"**：已存在部门下的新组 → `materialized_path = /<id>` 而 `parent_id` 是对的 → 祖先链为空 → 部长失去编辑权；**若部门是 restricted，这个组不继承受限 → 所有人可读** | ✅ 已修（三分支显式处理，取不到父路径就抛错）                                  |
| 🔴 Critical | `apps/web/.../PageEditor.tsx`                          | **编辑器静默丢字 + 假的「已自动保存」**：`dirtyRef` 一个布尔兼表两件事，保存期间的新输入被清成"已保存"，卸载补保存与 `beforeunload` 也被同一标记关掉                                                 | ✅ 已修（`editSeq`/`savedSeq` + 写入串行 + 冲突不清标记 + 按钮写明"放弃改动"） |
| 🟠 High     | `apps/api/src/node/node.service.ts`                    | **`move` 到一级完全没有校验**：绕过"一级节点只有管理员能建"，且**把节点从受限祖先下摘出来 → 对所有人可读**                                                                                           | ✅ 已修（补 `requireCreateUnder(operator, null)`）                             |
| 🟡 Medium   | `CommentsPanel.tsx` / `CommandPalette.tsx`             | 没判 `isComposing` → 中文输入法确认候选词时发出半截评论 / 打开搜索结果                                                                                                                               | ✅ 已修                                                                        |
| 🟡 Medium   | `apps/web/vite.config.ts`                              | 生产构建发 source map，等于把整个前端源码（含注释）随站点发出（3.9 MB）                                                                                                                              | ✅ 已修（`sourcemap: false`，已验证 dist 无 `.map`）                           |
| 🟡 Medium   | `scripts/audit-docs.mjs`（第 12 项检查，我上轮新加的） | **假阴性**：一句注释就能让缺失的变量行蒙混过关（实测 exit 0）；**假阳性**：单元格含内层反引号时行明明在却报"查不到"                                                                                  | ✅ 两处都修 + 变异测试验证                                                     |

### 文档与版本

- `DESIGN.md` 已记到 **v4.7**（v4.5 / v4.6 / v4.7 三条变更记录），版本号与最新一行一致由门禁强制
- `audit-docs.mjs` 现在是 **12 项**检查（新增：文档只留一篇、字号刻度、§9.1 环境变量表覆盖）

---

## 2. 待办：按优先级（剩下的全在这里）

> 这些都是**"门禁绿、行为错"**那一类 —— 静态检查抓不到。每条都给了 `文件:行` 与改法方向。
> 行号是**当前工作区**的（改动之后可能位移，按内容找）。

### 2.1 第一优先（改法小、影响大，建议先做这 6 条）

| #      | 位置                                                                                                                | 问题                                                                                                                                                                                                                                                                     | 改法                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **A1** | `apps/api/src/auth/auth.service.ts:118-143`                                                                         | `setup()` 的事务是 **READ COMMITTED** → 两个并发 `POST /auth/setup` 都看到 `count()==0`，**都能提交 → 两个超管**（注释却声称"只有一个能成功"）。仓库别处都用 `runSerializable`（`common/db/serializable.ts`）                                                            | 改用 `runSerializable(...)`；并把 `P2002`（同工号）映射成同一个 403                                              |
| **A2** | `apps/api/src/node/node.service.ts:353-387`、`apps/api/src/org/org.service.ts:371-420`                              | `create` / `createOrgNode` 的**父路径是在事务外读的**，再用这个快照写子节点路径 —— 与刚修的 C1 同一类 TOCTOU。并发移动父节点 ⇒ 永久断裂的祖先链，且不报错                                                                                                                | 在事务内重读父节点 `materializedPath`（3 行，照抄 `move` 的做法）                                                |
| **A3** | `apps/api/src/org/org.service.ts:648-684, 696-728, 504`                                                             | `addMember` / `removeMember` **先写库、再用 `this.members()` 组装响应**，而 `members()` 开头是 `requireRead` → 超管在"自己没拥有、没创建、也不在名单里"的受限节点上**写成功了却收到 404**。`replaceReaders` 已经修过同一个坑（原则写在 `permission.service.ts:479-489`） | 响应不走读判定（复用已组装的视图），或把 `requireRead` 提到写之前                                                |
| **W1** | `apps/web/src/routes/AppLayout.tsx:245-249`                                                                         | **登出会丢未保存的正文**：`onSettled` 里才导航，于是卸载补保存发生在 **cookie 已吊销之后** → 401 → 内容丢；而且登出绕过了 `beforeunload` 的确认                                                                                                                          | 登出前先冲刷未保存内容并 `await`；冲刷不掉就弹确认。需要一个小的"待保存登记"机制（见 §2.4 备注）                 |
| **W2** | `apps/web/src/features/content/editor/Toolbar.tsx:58-72,171-183`；`TableMenu.tsx:84,123`；`LinkPopover.tsx:119-123` | 工具栏/表格菜单/链接气泡**只挂 `onMouseDown`**，而键盘激活只产生 `click` → 加粗、标题、列表、代码块、撤销、插图、链接、表格**全部键盘不可达**（WCAG 2.1.1 Level A）                                                                                                      | 除 `onMouseDown` 外再接 `onClick`，**并且只在 `event.detail === 0`（键盘触发）时执行**，否则鼠标点一次会执行两遍 |
| **W3** | `apps/web/src/features/org/queries.ts:165`                                                                          | `setQueryData` **无条件写入**：两次保存并发时先发后回的旧响应会覆盖新响应 → 下次 remount 拿到旧正文与旧 `baseUpdatedAt` → 又报假冲突                                                                                                                                     | 写入前比较 `saved.updatedAt >= prev.updatedAt`（ISO 字符串可直接比大小）                                         |

### 2.2 第二优先（其他 High / Medium）

**API**

- `search/search.service.ts:100-118` — `LIMIT 20` 在 SQL 里先截断，**之后**才逐条 `canRead` → 命中 25 条而只有 5 条可读时，用户只看到 0–4 条，且**静默**。改法：SQL 里过滤，或循环 over-fetch 直到凑够 20 条可读；至少返回"被截断"标记
- `node/node.service.ts:157-183, 237` — `GET /org/tree?root=<id>` 是**受限节点的存在性预言机**：不存在 → 404，存在但读不到 → 200 + `nodes: []`。改法：建树前先 `requireRead(operator, rootId)`
- `audit/audit.service.ts:147-162` + `prisma/schema.prisma:313` — 审计查询的 WHERE（`actor_id = … OR target_id = ANY(…) OR detail->>'nodeId' = ANY(…)`）**没有可用索引**，只有 `audit_created_idx(created_at DESC)`。改法：补 `actor_id`、`target_id`、`(detail->>'nodeId')` 索引（要迁移）
- `search/search.service.ts:81-101` + `schema.prisma:262` — 文档宣称的"GIN 三元组索引"**实际用不上**：索引建在 `text_for_search`，谓词却是 `COALESCE(c.text_for_search,'') ILIKE …`；而另一个 OR 分支 `n.title ILIKE …` **根本没有索引**。改法：WHERE 用裸列（`COALESCE` 只留在 ORDER BY），并给 `nodes.title` 加 trgm GIN。**改动前先用 `EXPLAIN` 对比**
- `search/search.service.ts:112-116` — 检索热路径 N+1：最多 20 次串行 `access()` ×（≈5–7 次往返）≈ **140 次串行往返**。改法：一次取全部命中的祖先链 + 一次 `accessListsFor` + 一次世代号
- `org/import.service.ts:456, 488-498` + `org/import.core.ts:626-654` — 导入改 `owner_id` 只查 `requireSuperAdmin`，**不查 `canManage`**（而 §5.3 说改二级节点所有者要祖先所有者），也**不查在职状态** → 节点能被交给离职/停用账号（"这个节点就废了"）。改法：复用 `OrgService.setOwner` / `assertActiveUser`
- `auth/login-throttle.ts:197-207` — `INCR` + `EXPIRE` **非原子**：`expire` 失败则计数键**永不过期**，且 `value === 1` 再也不会出现 → "零星打错不会累积"这条性质**永久失效**，之后每次失败都直接锁。改法：`SET key 0 EX window NX` 再 `INCR`，或 Lua
- `auth/login-throttle.ts:168-171` — **IP 窗口**触发时返回的却是**账号窗口**的秒数；默认值相等所以看不出来，配置不同就会**告诉用户错误的等待时间**
- `node/content.service.ts:117-135` — 深度嵌套的 `content` → **500 而不是 400**（`isProseMirrorDoc` 只查两层，随后递归 `countImages`/`JSON.stringify` 爆栈；实测 540 KB 就触发，远低于 2 MB 上限）。改法：迭代式深度/节点数预检 → 400
- `common/filters/all-exceptions.filter.ts:23-31, 76-93` — 超限 multipart 被 Nest 映射成 413，而过滤器没有 413 条目 → **HTTP 413 却带 `VALIDATION_FAILED` 码**，与 §6.1「VALIDATION_FAILED = 400」矛盾
- `org/import.core.ts:54` vs `auth/dto/login.dto.ts:12` — **两套 `EMPLOYEE_NO_PATTERN`**（≤32 须字母数字开头 vs ≤64 允许 `._-` 开头）。用 `_kc01` 或 33 位工号建的账号，会让**整批导入失败**。改法：移进 `@knowledgecool/shared` 共用
- `app-setup.ts:82-95` vs `config/configuration.ts:79` — "WEB_ORIGIN 未配置就报错"这个硬失败**不可达**（配置已经默认成 `http://localhost:5173`），于是生产忘了配就**静默放行 dev 源**
- `health/health.controller.ts:16, 35-40` + `health.service.ts:16-19, 70-86` — `/health/ready` 是 `@Public()`，未鉴权、无限流，且返回最多 160 字符的**原始依赖错误文本**（host/port/驱动信息）→ 轻微内网拓扑泄露。改法：未鉴权只回状态，细节只进日志
- `upload/upload.controller.ts:74-127` — 上传**只按扩展名校验**（不看 magic bytes），无按人配额，孤儿文件不回收（后两条已记欠账）。改法：嗅探文件头 + 按人限额 + nginx `nosniff`
- `schema.prisma:142-151` — `version` 那段权威注释说"变更所有者**不校验、也不递增**"，实际**递增**（`org.service.ts:452-455`、`import.service.ts:490-497`）。"不校验"是对的，代码行为也更好 → **改注释**
- `app.module.ts:23-40` / `permission.module.ts:6-16` / `search.module.ts:10-19` — 依赖图注释过期："SearchModule 不再依赖 PermissionModule"（v2.12 起它就依赖）；"PermissionService 只读三张表"（还读 `node_readers` 与 `users`）
- `comment/comment.service.ts:76-80` / `node/node.service.ts:170-179` — 两处无界读取（一个节点的全部评论；`/org/tree` 全表）。**已在文档里记作欠账**，不算新缺陷

**Web**

- `PageEditor.tsx:412-435` + `App.tsx:78-102` + `main.tsx:15-24` — **会话过期**只表现为一句"保存失败…继续输入会自动重试"（而它永远不会成功）；全应用唯一的 401 处理在 `RequireAuth`，只在 `me` 查询本身失败时反应。改法：中央处理 `UNAUTHORIZED`（fetch 包装或 QueryClient 的 mutation `onError`）→ 提示会话过期、跳登录、并**保住未保存快照**
- `OrgTreePanel.tsx:529-540` vs `:361-363` + `lib/tree-nav.ts:116-117` — 重命名输入框的 keydown **冒泡到 treeitem**：Enter 既提交改名**又跳到该节点**；方向键/Home/End 被 `preventDefault` → **改名时挪不动光标**。改法：输入框里 `stopPropagation()`，或 li 的处理里判 `event.target !== event.currentTarget`
- `OrgTreePanel.tsx:294-299, 802-804` — `handleRename` **先 `setRenamingId(null)` 再发请求**：409/403/网络失败时**用户敲的标题直接没了**（只存在于 DOM），而错误显示在侧栏底部（长树时看不见）。**`NodeDetailPage.tsx:239-266` 与 `UsersAdminPage.tsx:144-178` 已经修过同一个坑** → 照那边改（只在 `onSuccess` 里清状态）
- `PageEditor.tsx:323-342` + `lib/api.ts:145-155` — beacon 与本地状态不对账：(a) beacon 在用户回答"是否离开"**之前**就发了，选"留下"时快照其实已经写进库，而 `baseRef` 没推进 → 下一次自动保存被判 409，还去怪"别人改过"；(b) `sendBeaconJson` 返回 `false`（队列满）**被忽略**
- `queries.ts:47-57, 164-168` + `NodeDetailPage.tsx:511-514` + `PageEditor.tsx:137, 258` — 正文 `staleTime: Infinity` 且编辑器只在挂载时读一次：离开再回来若卸载补保存的响应还没到，会用**旧缓存正文 + 旧基线**重挂 → 下次保存撞 409
- `OrgTreePanel.tsx:357` — **没有 active 节点时整棵树没有 tab stop**（在 `/`、`/search`、`/audit` 时每行都是 `tabIndex={-1}`）→ 键盘进不去树
- `PageEditor.tsx:412-413` vs `:400-402` — **保存失败横幅没有 `role`/live region**（而次要的图片提示有 `role="status"`）；保存状态标签也从不上报。改法：失败横幅 `role="alert"`，状态标签 `aria-live="polite"`
- `CommandPalette.tsx:77-105, 133-167` — 缺 combobox/listbox 语义：输入框不是 combobox、结果是无语义 `<ul>`、高亮项没有 `aria-activedescendant`/`aria-selected` → 读屏用户不知道 ↑/Enter 会打开哪一条
- `link-url.ts:24, 42` + `LinkPopover.tsx:91, 95, 104` — `normalizeUrl` **只黑名单 `javascript:`/`data:`/`vbscript:`**，其它 scheme（`file:`/`blob:`/`vscode:`…）直通；而 Tiptap 的 Link 有自己的白名单 → `setLink` 返回 `false`（命令静默失败，气泡照样关），空选区那条分支走 `insertContent` 绕过校验，存进去的 href 渲染时被强制成 `href=""`（点开是当前页）。改法：改成**白名单**（http/https/mailto/tel/`/`/`#`），并检查 `chain.run()` 的布尔返回值
- `components/Modal.tsx:79-94` + `ui.tsx:67-79` — 焦点进入选的是 DOM 顺序第一个可聚焦元素（带头部的对话框就是右上角「关闭」）；opener 在 passive effect 里捕获，而 React 在 commit 阶段应用 `autoFocus` → 对话框正文里的 `autoFocus` 会被覆盖，**并且** opener 变成面板内元素 → `document.contains` 判定后**跳过焦点还原**。目前无 modal 用 `autoFocus`（潜在）
- `Modal.tsx:138-145` vs `AppLayout.tsx:287` + `styles.css:4-8` — scroll lock 改的是 `document.body.style.overflow`，而**真正滚动的是 `<main class="overflow-auto">`**（body 只是 `height:100%`）→ 对话框打开时背景**照样能滚**
- `components/ui.tsx:134-155` + `NodeDetailPage.tsx:224, 231` — `ErrorNote` 的「重试」是**可选参数**，只有 4 处传了；NodeDetail 的详情/正文失败页没传（而 `AppLayout.tsx:274-275` 的注释声称三处都给了）→ 文档加载失败只剩手动刷新
- `routes/HomePage.tsx:20-29, 113` — `relativeTime()` 在**渲染期读 `Date.now()`**，与仓库自己写的规则（时钟只在回调/effect 里读）冲突；且"3 分钟前"**永远不刷新**
- `OrgTreePanel.tsx:584-671` — 每行最多 **6 个可聚焦 `<button>`** 塞在 `role="treeitem"` 里（该文件自己的注释解释过为什么要避免），tab 停靠点变成 `1 + 6N`，与 §7.7 声称的"单一 roving tab stop"不符。改法：行内操作按钮 `aria-hidden` + `tabIndex={-1}`，改用键盘上下文菜单或节点页
- `Toolbar.tsx:33-72, 189-190` — 切换态**只靠颜色**（无 `aria-pressed`）；符号按钮（`B`、`⌀`、`↶`）的可读名只在 `title` 里。**注意**：`aria-pressed` 只该给真正的切换按钮，撤销/重做要给 `undefined`，否则会念成"未按下"
- `UsersAdminPage.tsx:256-263` / `SearchPage.tsx:49-56` / `CommentsPanel.tsx:87-101` — 输入框只有 placeholder、没有 `<label>`/`aria-label`
- `lib/api.ts:76, 128` — 响应 `as T` **无运行时校验**（错误体反而有守卫）→ 服务端改形状会变成渲染期崩溃
- `editor/popover.ts:28-54` + `TableMenu.tsx:37-39` + `LinkPopover.tsx:72` — `useDismiss` 依赖 `onClose`，而调用方每次渲染都传新的内联箭头 → 文档级监听器**每次渲染都重挂**（现在功能正常，但这是会演变成 stale closure 的那类写法）

### 2.3 文档待办（`DESIGN.md` 过度承诺，代码是对的）

- **§7.5（约 893-916）** 说三条保存路径"覆盖你" —— 实际上单一布尔标记会让一次成功保存把三条全部对新输入关掉。**已在代码里修，但文档这句话现在与修好的实现仍不完全一致**，建议改写成明确写出"写入串行 + 计数判脏"的行为
- **§7.6（约 922）** 说 `Modal` 锁 body 滚动 —— 实际 body 不是滚动容器（见上文）
- **§7.6（约 925）** 说 `ErrorNote` 给"重试"按钮 —— 它是可选参数，NodeDetail 没给（要么补上调用点，要么改文档）
- **§7.7（约 940）** 说组织树是 roving tabindex —— 实际无 active 时**没有** tab stop，且每行还有 6 个（见上文）
- `lib/use-document-title.ts:20` 注释说首页标题由 HomePage 恢复 —— 实际由 `AppLayout` 的路由标题表负责（行为没错，注释错）
- `DESIGN.md` v4.7 ① 里"v4.5 的总结里声称改掉了这条"这句**在仓库内无法证实**（v4.5 的变更记录没提 §8.4/dryRun）。可核实的部分（旧文档确实写反）是真的 → 建议把这半句改成可核对的表述
- §9.1 里 `NODE_ENV` 那行显示"跨行赋值,见 configuration.ts"，而实际是单行赋值（`gen-doc.mjs` 取第一个 `:` 之后文本的副作用）。**"有覆盖"≠"看得到值"**

### 2.4 建议顺手加的两个检查（都不是新缺陷，是"为什么门禁没抓到"的答案）

1. **`verify-db.mjs` 加"路径 ↔ 父子一致性"检查** —— C1 那一类（物化路径与 `parent_id` 不一致）**能过现有全部门禁**，就是因为没人查这个不变式。加上它以后这类问题会在 `pnpm db:verify` 就暴露
2. **`audit-docs.mjs` 或 `verify-doc-claims.mjs` 加"保存路径"行为断言** —— §7.5 那类"文档说覆盖、代码不覆盖"的偏差，只有打真接口或加断言才抓得到

**W1（登出冲刷）需要的机制备注**：编辑器目前把"待保存"完全封在组件内，而登出发生在 `AppLayout`。最小做法是加一个模块级登记表（例如 `apps/web/src/lib/pending-save.ts`）：编辑器注册一个 `flush()`，登出前 `await` 所有登记项。`beforeunload` 那条 beacon 路径仍要单独处理。

---

## 3. 运维事项（**改代码不会修好历史数据**）

C1 那个导入缺陷如果**已经在真实库里跑过**，那些行的 `materialized_path` 仍然是错的 —— 代码只防止以后再写错。请在有库的环境跑这条**只读**检测：

```sql
SELECT id, depth, materialized_path FROM nodes n
 WHERE depth <> length(materialized_path) - length(replace(materialized_path,'/','')) - 1
    OR (parent_id IS NOT NULL
        AND materialized_path <> (SELECT p.materialized_path || '/' || n.id
                                    FROM nodes p WHERE p.id = n.parent_id));
```

**每返回一行 = 一条断掉的祖先链**（也就是一处权限误判）。修复方式是按 `parent_id` 自顶向下重算 `materialized_path`/`depth`；建议先在副本上验证。

另外：**`session` 只存 token 的 SHA-256**（这个是对的），但 `restore.sh` / `migrate-import.sh` 那套备份链路的**磁盘同盘风险**按你的要求本轮完全没动。

---

## 4. 复核会话留在哪里

`.dsh` 的三个已完成复核会话我**保留**了（它们的完整报告比这里的摘要详细），路径：

```
C:\Users\Administrator\.dsh\sessions\--C-Users-Administrator-Desktop-knowledgeCool--\
  3c3b2f20-…  DESIGN.md ↔ 代码审计
  36dab769-…  第 1 轮复核（seed-dev）
  508d6d48-…  第 2 轮复核（修复再验）
  53486756-…  第 3 轮复核（门禁变异测试）
  b4f7e1f0-…  第 4 轮复核（安全 + 文档 claim）
```

每个会话有两份产物：`…\sessions\<id>\session.v4.jsonl.zstd`（记录）与
`…\storages\session_projcache\sessions\<id>.json`（投影缓存）。要删就**两份一起删**，否则会留孤儿缓存。

**产出为零的那三个失败会话我已经删掉了**（`7a1fe578` / `880e4d4a` / `0f9e5339`，共释放 796 KB）——
它们当时没留下任何报告，所以最初那轮"apps/api / apps/web / shared+infra 独立审查"其实没做成；
后来我用三个并行智能体补上了 api 与 web（就是本文件 §2.1/§2.2 的来源），
**但 `packages/shared` 与 infra（compose / nginx / .env）至今没有被独立审查过** —— 如果今晚有余力，这是下一个该补的空白。

---

## 5. 时间线要点（避免重复劳动）

1. 先做了环境（Node 进 PATH + npm 镜像 + 两个必要修补）
2. 自己全面审了一遍工作区，修了 H1/H2/M1–M7 与一批死代码
3. **独立复核（4 轮串行）** —— 每轮都抓到真问题，**其中两条出在我自己的修复里**：
   - 第 3 轮：我改的"接口区切片守卫"能被**我自己写的变更记录**绕过（`indexOf` 匹配到正文里的标题字符串）→ 切片静默放宽到 64% 而报"未发现漂移"
   - 第 4 轮：§8.4 那条我**声称改过、其实没落到文件上**（现在已改）
4. **并行复核（3 个）** —— 又抓到 2 Critical（导入物化路径、编辑器丢字）+ 1 High（`move` 越权）
5. 本轮修完上面这些，`pnpm check` 与 `pnpm build` 都是 EXIT 0

**教训（值得保留）**：门禁的"绿"不等于"对"。真正有效的是**变异测试**（故意制造违规，确认检查会变红）——
第 3 轮就是这样发现我那个守卫是纸糊的。给新检查配一条变异测试，比多写三行注释有用。
