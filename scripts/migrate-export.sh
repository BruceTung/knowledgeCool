#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 全量数据迁移 —— **导出端**
#
# 把"这套部署的全部数据 + 重建它所需要的配置"打成一个**单文件整包**,
# 拿到另一台机器上 import 就得到一模一样的一套。
#
# 用法:
#   ./scripts/migrate-export.sh                      # 生成 ./knowledgecool-migrate-<时间戳>.tar.gz
#   ./scripts/migrate-export.sh /mnt/usb/kc.tar.gz   # 指定输出路径
#
# 包内容:
#   <时间戳>/db.dump            数据库自定义格式导出(pg_restore 可恢复)
#   <时间戳>/uploads.tar.gz     附件目录
#   <时间戳>/manifest.txt       逐表行数快照(导入后用来对账)
#   <时间戳>/env.from-source    来源机的 .env **原样一份**(含密钥,见下方 ⚠️)
#   <时间戳>/source-info.txt    来源机的 git commit / 镜像 / compose 项目名
#   <时间戳>/RESTORE.md         目标机上怎么用这个包
#   <时间戳>/SHA256SUMS         上面几个文件的校验和
#
# ## 两个刻意的决定
#
# 1. **导出逻辑一份都不重写**:这里调 `backup.sh` 拿标准备份,再往上加
#    "迁移才需要的东西"(配置、来源信息、校验和、单文件打包)。
#    抄一份 pg_dump 出来的代价是某天有人只修了其中一份(§12)。
# 2. **`.env` 原样带走,而不是挑几个变量抄进一个新文件。** 挑着抄就是手写清单,
#    而手写清单一定会漏 —— 漏掉的那个变量在目标机上表现为某个功能莫名其妙不生效
#    (而这正是 §0 说的"文档/配置漂移"的老毛病)。整个文件带走,内容不会漂。
#
# ⚠️ **这个包里有密钥,也有全公司的数据。** 它必须按"机密资料"对待:
#    传输用 scp/sftp,不要丢在公共网盘;导入完成后可以把包删掉或加密归档。
#    `.env` 里的 SESSION_SECRET 尤其重要:换掉它会让**所有人重新登录一次**
#    (数据不丢,只是会话失效)。
# ============================================================
set -euo pipefail

# ⚠️ Windows(Git Bash / MSYS)必须关掉路径自动翻译 —— 见 backup.sh 里的详细说明。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT="${1:-$REPO_ROOT/knowledgecool-migrate-$(date +%Y%m%d-%H%M%S).tar.gz}"

if [[ ! -f .env ]]; then
  echo "❌ 找不到 .env —— 迁移包必须带上它,否则目标机上重建不出同一套配置"
  exit 1
fi

echo "==> 1/5 生成标准备份(复用 backup.sh,导出逻辑只有那一份)"
./scripts/backup.sh

BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"
STAMP="$(ls -1 "$BACKUP_ROOT" | sort | tail -1)"
SRC="$BACKUP_ROOT/$STAMP"
if [[ -z "$STAMP" || ! -f "$SRC/db.dump" ]]; then
  echo "❌ 没找到刚生成的备份:$SRC"
  exit 1
fi
echo "    备份:$STAMP"

echo "==> 2/5 采集配置与来源信息"
cp .env "$SRC/env.from-source"

{
  echo "exported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "backup_stamp=$STAMP"
  # git commit 是"从哪一版代码导出的"的**唯一可靠答案**;目标机上应当 checkout 同一版
  echo "repo_commit=$(git rev-parse HEAD 2>/dev/null || echo '(不是 git 仓库)')"
  echo "repo_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(未知)')"
  echo "compose_project=$(docker compose config --format json 2>/dev/null | sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
  # 用到的镜像名(api/web 是本地构建的,基础镜像 postgres/redis 是外部的)。
  # ⚠️ 不要用 `docker compose images --format '{{...}}'` —— 那个模板语法在本版
  # Compose 上不生效,会静默输出**空值**(第一版就是这样,source-info 里四条 image_*
  # 全是空串,而脚本自己一点感觉都没有)。改用 `config --images`,它是纯文本列表。
  echo "images:"
  docker compose config --images 2>/dev/null | sed 's/^/  /' || true
} > "$SRC/source-info.txt"

cat > "$SRC/RESTORE.md" <<'RESTORE_EOF'
# 怎么把这个迁移包导入目标机

前提:目标机已经装好 Docker,并且 **clone 了同一版代码**(见 source-info.txt 的 repo_commit)。

    git checkout <repo_commit>
    cp <这个包>/env.from-source .env      # ⚠️ 这一步会把来源机的密钥一起带过来

> 想让"迁移完大家都无感"(没人需要重新登录),就用来源机的 .env。
> 想在新环境用新的数据库密码/会话密钥,就自己改 .env 里的
> POSTGRES_PASSWORD / SESSION_SECRET —— 代价是所有人重新登录一次,数据不受影响。
> ⚠️ 但 **POSTGRES_USER / POSTGRES_DB 建议保持一致**,省得后面自己都对不上。

然后:

    docker compose up -d --build          # 先让空库跑起来(迁移会自动建表)
    ./scripts/migrate-import.sh <这个包>   # 导入数据(会要求输入 yes 确认)

导入脚本做四件事:校验校验和 → 解开 → 交给 restore.sh 恢复 → 逐表比对行数。
RESTORE_EOF

echo "==> 3/5 计算校验和"
( cd "$SRC" && sha256sum db.dump uploads.tar.gz manifest.txt env.from-source source-info.txt RESTORE.md > SHA256SUMS )
cat "$SRC/SHA256SUMS" | sed 's/^/    /'

echo "==> 4/5 打包成单文件"
# 只装我们确认过的那几个文件(SHA256SUMS 也在内),不把目录里别的东西顺手带走
tar -czf "$OUT" -C "$BACKUP_ROOT" "$STAMP"

echo "==> 5/5 完成"
printf '\n✅ 迁移包:%s\n' "$OUT"
printf '   大小:%s\n' "$(wc -c < "$OUT")"
printf '\n   下一步(在目标机上):\n'
printf '     1. git checkout %s\n' "$(sed -n 's/^repo_commit=//p' "$SRC/source-info.txt")"
printf '     2. docker compose up -d --build\n'
printf '     3. ./scripts/migrate-import.sh %s\n' "$(basename "$OUT")"
printf '\n   ⚠️ 包里含密钥与全公司数据,当机密资料对待(用 scp/sftp,别丢公共网盘)。\n'
