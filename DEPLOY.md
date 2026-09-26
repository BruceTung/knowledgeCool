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
WEB_ORIGIN=http://<服务器IP或域名>:8080
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
