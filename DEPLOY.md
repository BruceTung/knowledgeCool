# 知源 KnowledgeCool · 部署说明

阶段一的内网自托管部署。四个容器:`postgres` / `redis` / `api` / `web`(web 同时兼任反向代理)。

> 本文只覆盖**部署与运维**。设计与实现依据见 [`DESIGN.md`](./DESIGN.md);
> 做代码改动前请先改 DESIGN,再改代码。

---

## 0. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Linux x86_64(Ubuntu 22.04+ 实测) | Windows 只作为开发机 |
| Docker | 24+ | `docker compose` 需要 v2 语法 |
| 内存 | **2 GB 起,建议 4 GB** | 构建阶段(api 镜像要跑 pnpm install)是内存峰值 |
| 磁盘 | 20 GB 起 | 镜像 + 数据 + 附件 + 备份 |
| 端口 | 一个对外端口(默认 8080) | 80/443 若被占用,用 `WEB_PORT` 改 |

检查环境:

```bash
docker --version && docker compose version
free -m | head -2
df -h /
```

---

## 1. 取代码

```bash
git clone <仓库地址> knowledgeCool
cd knowledgeCool
```

> 镜像构建的上下文是**仓库根目录**(monorepo 需要整个 workspace 才能装依赖),
> 所以不要在子目录里执行 `docker build`。

### Windows 本地开发的一个额外步骤

如果只打算部署到 Linux 服务器,可以跳过这一节。

某些 Windows 环境下 `pnpm install` 会**静默不创建**新依赖的符号链接
(pnpm 报 `Done`,但 `apps/web/node_modules/@xxx` 是空的),
表现为 `Cannot find module` 或类型检查里"命令方法集体消失"。此时补两行:

```bash
node scripts/fix-pnpm-links.mjs .
node scripts/fix-pnpm-hoist.mjs .
```

这两个脚本**只在 Windows 本地开发时需要**,Docker 构建不受影响 ——
详见 `~/.workbuddy/skills/pnpm-symlink-repair/`。

---

## 2. 配置 `.env`

```bash
cp .env.example .env
```

**必须改的三个值:**

```bash
# 1) 数据库密码。别用 change-me-in-production
POSTGRES_PASSWORD=$(openssl rand -hex 24)

# 2) 会话密钥(阶段二协同网关签短期 JWT 用;阶段一的会话本身不依赖它)
SESSION_SECRET=$(openssl rand -hex 32)

# 3) 对外访问的地址。前端与 API 同源,这里填最终用户看到的地址
#    可以写多个,用逗号分隔(例如同时保留内网地址与 localhost 供调试)
WEB_ORIGIN=http://<服务器IP或域名>
```

### ⚠️ `SESSION_COOKIE_SECURE` 必须和访问协议匹配

这是最容易卡住人的一处:

| 访问方式 | 该设成 | 不匹配的后果 |
|---|---|---|
| `https://…` | `true`(默认) | — |
| `http://…` | **`false`** | 浏览器**不回传 Cookie**,表现为「登录明明成功,一刷新又回到登录页」 |

阶段一的 TLS 视部署方式而定:有域名就上 Let's Encrypt(见 §6);
没有域名、直接用 IP + http 访问时,**必须显式设 `SESSION_COOKIE_SECURE=false`**。

### 回收站保留策略(v2.4)

```bash
# 删除的东西在回收站里放多少天之后被**自动彻底删除**。默认 30。
# ⚠️ 填 0(或负数)= 关闭自动清理,回收站里的东西不会自己消失。
TRASH_RETENTION_DAYS=30
# 扫描间隔(小时)。0 同样表示关闭。默认 6。
TRASH_PURGE_INTERVAL_HOURS=6
```

**这三个事实必须知道:**

1. **到点就是不可逆的物理删除** —— 与界面上的「彻底删除」是同一条代码路径。
   不放心就先设 `TRASH_RETENTION_DAYS=0` 关掉它,只用手动清理。
2. **超管可以手动触发一次**,并且支持先空跑看清单:

   ```bash
   # 只列不删(先在界面上"回收站 → 按保留策略清理"看也行)
   curl -b cookie.txt -X POST 'localhost:8080/api/v1/admin/maintenance/trash-purge?dryRun=true'
   ```

   界面上的入口在「回收站」页右上角,只有超管看得到。
3. **每次清理都写审计**(`node.purge.auto`,actor 为空,带标题与子树大小),
   在 `/audit` 里能查到"哪些东西是系统到期清掉的"。

附件的大小上限与扩展名白名单**不在这里配** —— 它们是代码里的常量
(`apps/api/src/upload/upload.controller.ts`)。放宽白名单是安全决策,
不该靠改一个环境变量就能做到。

---

## 3. 启动

### ⚠️ 先确认云安全组放行了哪个端口

**这是实际部署时第一个卡住人的地方。** 容器映射了端口 ≠ 公网能访问 ——
云厂商的**安全组**是另一道闸,和服务器上的 iptables / ufw 都不是一回事,
而且它只能在云控制台(或云 API)改,**在服务器里改不了**。

本项目的构建服务器(`43.134.60.6`)只放行了 **22 与 80**。从公网侧探测的结果:

| 端口 | 结果 |
|---|---|
| 22 | 通(SSH) |
| 80 | **通** ← 用它 |
| 8080 | 超时(被安全组丢弃,不是 refuse) |
| 443 | ECONNREFUSED(没服务在听) |

所以这台机器的 `.env` 里是:

```bash
WEB_PORT=80
WEB_ORIGIN=http://43.134.60.6,http://localhost:8080
```

换一台机器时,先探一遍再定 `WEB_PORT`:

```bash
# 在**你自己的机器**上跑,不是在服务器上
curl -m 8 http://<公网IP>/api/v1/health        # 期望 200
```

> **服务器上 `curl localhost:8080/api/v1/health` 通,不能说明公网能访问。**
> 那只说明容器活着 —— 公网那道闸在云安全组上。
> 这两件事很容易混为一谈,而表现是"我明明本地能开,别人打不开"。

> `docker-compose.override.yml`(部署侧、不进仓库)在这台机器上额外映射了
> 宿主机 `8080:80`,只供**服务器本机与内网**调试 —— 公网访问 8080 是不通的。

### 启动

```bash
docker compose up -d --build
```

首次会构建 api / web 两个镜像(几分钟;取决于网速,api 镜像要拉 pnpm 依赖)。

观察启动:

```bash
docker compose ps
docker compose logs -f api
```

`api` 的启动命令里包含 `prisma migrate deploy` —— 迁移会自动执行,幂等,重启不会重复跑。

---

## 4. 验收

```bash
# 存活(不碰外部依赖)
curl -s localhost:8080/api/v1/health

# 就绪(同时报告 database 与 redis)
curl -s localhost:8080/api/v1/health/ready

# 是否需要初始化
curl -s localhost:8080/api/v1/auth/setup-state     # {"required":true} 表示是一个空库
```

浏览器打开 `http://<IP>:8080`,会被引导到 `/setup` 创建第一个管理员。

**`/setup` 只在库里没有任何用户时可用** —— 这一点由服务端强制,
所以不用担心有人事后跑到那个地址再建一个管理员。

---

## 5. 备份(上线前必须做)

```bash
# 备份到 ./backups/<时间戳>/
./scripts/backup.sh

# 恢复演练:把备份恢复到一个临时库并逐表比对行数(不动生产库)
./scripts/restore-drill.sh

# 真实恢复(会二次确认;库里数据会被覆盖)
./scripts/restore.sh
```

**为什么必须有演练步骤:** 没被恢复过的备份等于没有备份。
`restore-drill.sh` 会把备份导入一个 `drill_*` 临时库、逐表比对行数、再删掉,
通过之后你才知道这份文件是真的能用。

**异地备份**:把 `BACKUP_ROOT` 指到挂载的网盘或 rsync 目标:

```bash
BACKUP_ROOT=/mnt/backup ./scripts/backup.sh
```

> 备份留在同一块磁盘上等于没有备份。这是 DESIGN §11.1 的头号风险项,
> 脚本只能产生备份,**放到哪里是运维决定**。

建议加一条 crontab:

```cron
# 每天 03:10 备份
10 3 * * * cd /opt/knowledgeCool && ./scripts/backup.sh >> /var/log/kc-backup.log 2>&1
# 每周一 04:00 演练最近一次备份
0 4 * * 1 cd /opt/knowledgeCool && ./scripts/restore-drill.sh >> /var/log/kc-drill.log 2>&1
```

---

## 6. 上 HTTPS(有域名时)

内网也要上 HTTPS —— 浏览器在非安全上下文里会限制剪贴板 API、
部分 WebSocket 升级和 Service Worker,而这些恰好是协同编辑与粘贴图片要用的
(DESIGN §2.4)。

最省事的做法是在宿主机上用一个 Nginx/Caddy 反代到 8080:Caddy 会自动申请证书。

```caddyfile
kb.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

上完 HTTPS 后把 `.env` 改回:

```bash
WEB_ORIGIN=https://kb.example.com
SESSION_COOKIE_SECURE=true
```

然后 `docker compose up -d` 让 api 重新读取环境变量。

---

## 7. 升级

### 有仓库的部署密钥时

```bash
git pull
docker compose up -d --build
```

`prisma migrate deploy` 会在新容器启动时自动应用新增的迁移。
**升级前先备份** —— 回滚代码容易,回滚数据库不容易。

### ⚠️ 没有部署密钥时:用 tar 传代码(本项目的实际情况)

本项目的构建服务器**没有配仓库的部署密钥**,所以升级走"本地打包 → scp → 解包":

```bash
# 本地:打包(排除掉不该传的东西)
tar -czf /tmp/kc-src.tar.gz \
  --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.git' \
  --exclude='./.workbuddy' --exclude='*/dist' --exclude='./prototype' \
  --exclude='./.env' --exclude='./apps/api/src/generated' \
  -C <仓库根目录> .

scp /tmp/kc-src.tar.gz ubuntu@<服务器>:/tmp/kc-src.tar.gz
```

```bash
# 服务器:解包前**必须先把源码目录清空**
cd ~/knowledgeCool
mkdir -p /tmp/kc-keep
mv .env docker-compose.override.yml DEMO-ACCOUNTS.txt backups /tmp/kc-keep/ 2>/dev/null
mv .env.bak-* /tmp/kc-keep/ 2>/dev/null
find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf /tmp/kc-src.tar.gz -C .
find /tmp/kc-keep -mindepth 1 -maxdepth 1 -exec mv {} . \;
rm -rf /tmp/kc-keep
docker compose up -d --build
```

> **为什么解包前要清空:`tar -xzf` 覆盖不会删除已被移除的文件。**
> 某个版本里删掉的前端模块(例如 v2.0 删掉的 `features/pages`)会原样留着,
> 而它们引用的共享类型已经不存在 → `tsc` 直接失败、镜像建不出来。
> 这个坑在 v2.0 部署时踩过一次,所以写在这里。

> `apps/api/src/generated`(Prisma 生成物)不必传 —— 镜像构建时 `prisma generate`
> 会重新生成。排除它既减小包体,也避免把旧版本生成物带到新版本里。

### 升级后自检

```bash
docker compose ps                                  # 四容器 healthy
docker compose exec api node scripts/verify-org.mjs   # 129 项端到端断言
```

> 验收脚本已进镜像(`apps/api/Dockerfile` 里 COPY 了 `scripts/`),所以能在容器内直接跑,
> 不必在宿主机上再装一份 Node 与依赖。

---

## 8. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录成功但刷新后回到登录页 | `SESSION_COOKIE_SECURE=true` 却在用 http 访问 | 改成 `false` 后 `docker compose up -d` |
| `api` 容器反复重启 | 数据库没起来 / 密码不对 | `docker compose logs api`,核对 `.env` 的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` |
| 页面能开、接口 502 | api 未 ready | `docker compose ps` 看 api 是否 healthy;`logs api` 找 `migrate deploy` 是否失败 |
| 图片 404 | web 容器没挂到 uploads 卷 | `docker compose config` 看 web 的 volumes 里有没有 `uploads:/data/uploads:ro` |
| 中文搜索搜不到 | `pg_trgm` 扩展或三元组索引丢失 | `docker compose exec postgres psql -U knowledgecool -d knowledgecool -c "\dx"` 确认 `pg_trgm` 在;`\di node_contents_trgm_idx` 确认索引在 |
| **回收站里的东西不见了** | 保留期到了,被 `RetentionService` 自动清掉 | 这是**设计行为**。先去 `/audit` 搜 `node.purge.auto` 确认;不想让它发生就设 `TRASH_RETENTION_DAYS=0` |
| **某人不在某个组的成员列表里了** | 他的归属被移出,或本来就没加过 | 节点的成员弹窗(`☰`)能查"这个节点下都有谁";调岗是**两步**:先加入新节点,再从原节点移出 |
| 磁盘被备份撑满 | 没清理旧备份 | 给 `backups/` 加保留策略(例如只留最近 14 天),**不要**用 `rm -rf` 一把清 |

---

## 9. 交付检查清单

上线前逐项打勾:

- [ ] `.env` 里的 `POSTGRES_PASSWORD` / `SESSION_SECRET` 都是随机生成的,不是样例值
- [ ] `SESSION_COOKIE_SECURE` 与访问协议匹配(见 §2)
- [ ] `curl /api/v1/health/ready` 报告 database 与 redis 均 up
- [ ] 已创建管理员,并且**没有**在库里留下测试账号
- [ ] `./scripts/backup.sh` 跑通,且备份已被同步到异地
- [ ] `./scripts/restore-drill.sh` 跑通
- [ ] **确认回收站保留策略符合预期**(v2.4,默认 30 天后自动彻底删除;
      不需要就设 `TRASH_RETENTION_DAYS=0`;界面上的天数取自服务端,不是写死的)
- [ ] 四个容器都是 `restart: unless-stopped`(compose 默认已配)
- [ ] 记下 `docker compose logs` 的位置,出问题时有人知道去哪看

---

## 10. 演示账号与验收流程

> 这一节是**随仓库的**(不会被 `seed:dev` 覆盖)。
> `DEMO-ACCOUNTS.txt` 是种子脚本生成的运行时副本,只含账号表与入口,
> 完整流程以本节为准。

### 10.1 账号(2026-09-27 实测)

| 工号 | 姓名 | 角色 | 密码 | 首登要改密 |
|---|---|---|---|---|
| KC001 | 林晓 | 超级管理员 | `Kc-admin-2026` | 否 |
| KC002 | 陈默 | 技术部部长 | `Kc-verify-2026` | 否 |
| KC003 | 王思远 | 后端组组长 + CRM 项目组长 | `123456` | **是** |
| KC004 | 赵敏 | 技术部 / 后端组 组员 | `123456` | **是** |
| KC005 | 孙浩 | 市场部部长 | `Kc-verify-2026` | 否 |

组织形态:

```
技术部(部长 陈默)
  ├─ 后端组(组长 王思远)
  └─ CRM 项目(组长 王思远)
市场部(部长 孙浩)
```

文档:研发规范、技术方案、接口规范、CRM 项目概览、市场部工作方式。

> ⚠️ **KC003 / KC004 的初始密码是 `123456`,登录后会被强制改成**
> 「8 位以上且同时含字母与数字」的新密码。这是刻意留的 ——
> 用来演示"首次登录必须改密"。改完请记住自己设的那个。

### 10.2 跑验收脚本**不会**再改坏演示账号(v2.6 起)

`verify-org.mjs` 里有一段「验证首次登录强制改密」的断言:它用初始密码登录 KC003,
然后**真的把密码改掉**(要验就真验,不能只看界面);`login()` 这个辅助函数
还会顺手改掉 KC004。

**v2.5 及以前,这件事没有任何地方还原。** 后果有两条,都真的踩过:

1. 跑过一次验收,上面表里写的 `123456` 就登不上了(用户反馈过一句「测试账号没了?」)
2. 下一轮跑到 A 组时会走"跳过"分支,总项数从 160 掉到 148 ——
   看着像回归,其实是**上一轮脚本自己造成的**

v2.6 起,**脚本最后一组(N)会用超管的「重置密码」接口把 KC003 / KC004 放回去**,
所以它是幂等的:连跑几次结果都一样。实测本地连跑三次是 `148 → 160 → 160`,
服务器连跑两次都是 `160`。

> 所以看到的总数应当**始终是 160**。若某次是 148,说明 N 组没跑到
> (脚本中途抛了异常)—— 那本身就是要查的问题,而不是"正常的跳过"。

万一 N 组没跑到,手工还原(两条路,任选):

```bash
# a) 走界面:用 KC001 登录 → 人员 → 对 KC003 / KC004 点「重置密码」
# b) 走脚本(直接写库,见下方警告)
docker compose exec api node scripts/reset-demo-passwords.mjs
docker compose exec api node scripts/reset-demo-passwords.mjs KC003 KC005   # 也可指定工号
```

`reset-demo-passwords.mjs` 做三件事:重置为 `123456`、把 `must_change_password`
置回 `true`、**并踢掉这些账号的所有会话**(会话表里存的是 token 的 SHA-256,
改密码不会让已发出的会话失效 —— 不删的话会出现"改完密码旧标签页还能用")。

> ⚠️ 这个脚本**绕过 API、不留审计**,只在演示环境用。生产环境用界面上的
> 「重置密码」—— 那条路会记审计。

### 10.2.1 同事忘了密码:用界面上的「重置密码」

`人员 → 每人一行右侧 → 重置密码`(超管)。这是系统里**唯一**的忘密码出口,
它会:把密码打回 `123456`、置 `must_change_password`、**并立刻吊销他的全部会话**。

界面上的确认框会写明三件事,其中第二件最要紧 ——
**他正在编辑但没保存的内容会丢**。所以别在他正写文档的时候做。

两条刻意拒绝(服务端也拦):

- **不能重置自己** —— 能点到这个按钮就说明你已经登进来了。
  想改自己的密码走右上角「改密」。
- **不能重置「已离职 / 已停用」的人** —— 重置了也登不进来。
  要让他能登录,先把状态改回「在职」。

> **⚠️ 这个能力与"超管不自动拥有内容编辑权"这条设计有张力,如实写在下面。**
>
> 重置密码之后,超管就有了一个用新密码登进别人账号的路径 —— 于是他能以那个人的
> 身份改内容,而内容权限本来是他刻意不持有的。**这不因为我们不做就不存在**:
> 在这之前,忘密码只能靠运维进容器改库 —— 那条路**权限更大、完全无痕**,
> 而且运维往往与超管不是同一个人却拥有更高的实际权限。
>
> 提供这个接口的判断是:**把不可见的能力换成可见的、留痕的、且会惊动本人的能力,
> 是净收益**。三条缓解:
>
> 1. 每一次重置都进审计日志(`org.user.reset_password`,记操作者与目标)
> 2. 重置会**踢掉他的会话并强制他改密** —— 他没做过这个操作,自己会发现
> 3. 部署时应当把超管交给可信的人,并**定期看审计日志**(`/audit`)
>
> 要更严可以加"重置后通知本人"或"双人审批",已记在 `DESIGN.md` §11.3。

### 10.3 验收流程(按顺序做,每一步都写了"应该看到什么")

**第 1 步 · 超管是组织架构的起点**
用 KC001 登录。
- 登录后**直达工作台**,左侧是完整组织树(两个部门、两个组、五篇文档)
- 顶部有「组织架构」「人员」入口(只有超管看得到)
- 悬停「技术部」那一行:只出现 `☰`(成员),**没有** `⚙`(权限)
  —— 这不是 bug。超管管组织架构,不管内容;内容权限归部长。这两件事是分开的。

**第 2 步 · 首次登录强制改密(一定会看到)**
退出,用 KC004 / `123456` 登录。
- 立刻被跳到「修改密码」页,别的页面进不去
- 试 `12345678`(纯数字)→ 被拒,提示要含字母
- 试 `abc`(太短)→ 被拒,提示至少 8 位
- 试 `Zhao1234` → 通过
- ★ 改密之前,**手工在地址栏敲别的 URL 也进不去**(服务端 403 拦的)

**第 3 步 · 谁能改什么**
以 KC004 赵敏:
- 能打开技术部的任何文档 —— **读对所有登录用户开放**
- 点「技术方案」标题想改名 → 改不动
- 点「接口规范」标题 → **能改**(种子把她加进了这个节点的额外授权)

换 KC005 孙浩(市场部部长):技术部的文档**能读能搜、改不动**。

换 KC002 陈默(技术部部长):技术部下的**全部**文档都能改 ——
他不是每篇的作者,但他是「技术部」节点的所有者,权限沿祖先链往下走。
这就是"**越靠上权限越大**"。

**第 4 步 · 权限弹窗的三段划分**
以 KC002,树上悬停「接口规范」→ 点 ⚙。
- 第一段「所有者」:陈默
- 第二段「上级所有者 · 1」:来自「技术部」的陈默 —— **不可移除**
- 第三段「额外授权 · 1」:赵敏,显示"由 陈默 添加" —— 只有这段可增删
- 候选人下拉里**只有技术部的人**:试着找孙浩,找不到
  (组长不能把权限给别的部门的人;服务端也会再挡一次)

**第 5 步 · 节点成员:这个节点下都有谁(v2.4)**
以 KC002,树上悬停「技术部」→ 点 `☰`。
- 「直接成员 · 1」:陈默,标「本节点所有者」,右侧有「移出」
- 「下属成员 · 2」:王思远、赵敏 —— 他们归属在**下面的组**上,
  所以这里**没有**移出按钮(要移出请到对应组那一层)
- 王思远那行显示他在这棵子树里有**两条**归属:后端组、CRM 项目
- 底部「添加成员」下拉只列他组织范围内的人
- ★ 点陈默的「移出」→ 确认框写明两件事:移出归属**不改变所有权**;
  但会**缩小他的组织范围**。这两句话是这件事的安全边界,有单测钉住

换 KC004 登录打开同一个弹窗:她**能打开**(读全员开放),
但**没有**移出/加入按钮 —— 服务端也会挡(403),前端只是不显示。

**第 6 步 · 调岗(两步走)**
这是 Excel 增量导入表达不了的那一步:
- 以 KC002,在「CRM 项目」的成员弹窗把赵敏「加入」
- 再到「后端组」的成员弹窗把她「移出」
- 回「技术部」的成员弹窗看:她现在是"CRM 项目"的人
- 想还原:同样两步反过来做一遍

**第 7 步 · 回收站与保留策略**
以 KC001 进左下角「回收站 →」。
- 页面上写着:"这里的条目会在删除满 30 天后被自动清理(每 6 小时扫一次)"
- 右上角有「按保留策略清理」(只有超管有)
- 先删一篇文档(树上悬停 → ×),回回收站:
  - 能看到它,还带"原父节点是否还在树上"的提示
  - 点「按保留策略清理」→ 提示"没有删除满 30 天的条目,无需清理"
    —— 说明**保留期内的东西不会被误删**
  - 点「恢复」把它救回来
- ★ 彻底删除的门槛比移入回收站高:能改还不够,得是它或它上级的所有者

**第 8 步 · 审计日志**
以 KC001 进「审计日志 →」。
- 能看到刚才这一串动作:登录、建节点、授权变更、成员增删、所有者变更
- 特别看第 5、6 步产生的两条:**节点添加成员 / 节点移出成员**
- 移出组长那条会记下 `wasOwner: true` —— 谁把谁移出了、当时他是不是所有者

**第 9 步 · 检索不分权限**
按 Ctrl + K,搜「递归查询」。
- 能搜到「技术方案」
- 换 KC005 登录再搜同一个词 → **照样能搜到**
- ★ 因为读是全员的,检索也就不做权限过滤。
  代价是:**系统不提供任何保密能力** —— 别把薪酬、合同这类东西写进去。

### 10.4 验收完成后的收尾

- 把演示账号停用(人员管理 → 状态改成「已停用」),或干脆换一套自己的数据
- `./scripts/backup.sh` 做一次备份
