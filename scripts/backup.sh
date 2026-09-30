#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 备份脚本(DESIGN.md §9 M6)
#
# 做三件事,顺序不能颠倒:
#   1. pg_dump 数据库(自定义格式,支持按表恢复)
#   2. 打包附件目录
#   3. 写一份 manifest(含行数快照),供恢复后对账
#
# 用法:
#   ./scripts/backup.sh                    # 备份到 ./backups/<时间戳>
#   BACKUP_ROOT=/mnt/backup ./scripts/backup.sh
#
# ⚠️ 关于「异地备份」:DESIGN §11.1 把「备份介质未落实」列为头号阻塞项。
#    这个脚本只负责**产生**备份。把 BACKUP_ROOT 指到异地的路径
#    (挂载的网盘 / rsync 目标)是部署方的责任,脚本无法代劳。
#    备份写在同一个磁盘上等于没有备份。
# ============================================================
set -euo pipefail

# ⚠️ Windows(Git Bash / MSYS)必须关掉**路径自动翻译**,否则整套备份/恢复在 Windows 上跑不通。
#
# 实测:Git Bash 会把**独立出现的**绝对路径参数当成 Windows 路径来"翻译":
#     docker compose exec -T api tar -C /data/uploads .
#   → tar: can't change directory to 'D:/git/Git/data/uploads': No such file or directory
# 注意它**不是**无条件翻译 —— 藏在引号里的一整条命令(如 sh -c 'ls /data/uploads')没事,
# 所以这个坑只在个别行上爆,看起来像"那个命令有问题"而不是"环境有问题"。
#
# 后果很隐蔽:数据库那一步成功、附件那一步失败 —— 而附件正是最容易被忽略、
# 又最不可能从别处重建的东西。
#
# 这两个变量让 MSYS 不做转换;在 Linux 上它们根本不存在,等于无操作。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 从 .env 读库名与用户(compose 用同一份),不硬编码
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

PG_USER="${POSTGRES_USER:-knowledgecool}"
PG_DB="${POSTGRES_DB:-knowledgecool}"
BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"

mkdir -p "$DEST"

# ⚠️ 失败时把这个目录删掉,别把"半成品"留在 backups/ 里。
#
# 为什么值得专门写一段:备份目录一旦存在,后面的逻辑——保留期清理、
# `restore-drill` 取"最近一份"、定时任务——**都会把它当成一份正常备份**。
# 于是最坏的情况不是"没有备份",而是"以为有备份":磁盘满了导致 dump 被截断时,
# 文件非空、目录也在,一切看起来都成功,直到真的需要恢复的那一天。
#
# 失败原因在上面的输出里,排查靠那段输出,不靠残缺的文件。
FINISHED=0
cleanup() {
  if [[ "$FINISHED" -ne 1 ]]; then
    echo "❌ 备份未完成,已清理半成品目录:$DEST"
    rm -rf "$DEST"
  fi
}
trap cleanup EXIT

echo "==> 备份目标:$DEST"

# ---------- 1. 数据库 ----------
# -Fc = 自定义格式:压缩 + 支持 pg_restore 按表/按 schema 恢复
echo "==> 导出数据库 $PG_DB"
docker compose exec -T postgres \
  pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  > "$DEST/db.dump"

if [[ ! -s "$DEST/db.dump" ]]; then
  echo "❌ 数据库导出为空 —— 中止(空的备份比没有备份更危险,因为它看起来像成功)"
  rm -rf "$DEST"
  exit 1
fi

# ---------- 2. 附件 ----------
# 用 api 容器里的 tar 读卷,比在宿主机上找卷的物理路径可靠
echo "==> 打包附件目录"
docker compose exec -T api tar -czf - -C /data/uploads . > "$DEST/uploads.tar.gz"

if [[ ! -s "$DEST/uploads.tar.gz" ]]; then
  echo "❌ 附件打包为空 —— 中止"
  rm -rf "$DEST"
  exit 1
fi

# ---------- 3. 配置快照 ----------
# 备份不能**只有数据**。库导出来了,但"连上这个库"所需要的密钥(SESSION_SECRET、
# POSTGRES_PASSWORD)既不在 dump 里,也不在仓库里(.env 是 gitignore 的)。
# 服务器整个没了的时候,只拿着一份 db.dump 是重建不出一套能用的部署的 ——
# 而那一刻你才发现缺的是哪两个值,已经太晚。
#
# 代价:这个目录从此含密钥。所以目录权限收到 700、快照文件 600。
echo "==> 记录配置快照"
ENV_STATE="ok"
if [[ -f .env ]]; then
  cp .env "$DEST/env.snapshot"
  chmod 600 "$DEST/env.snapshot"
else
  # 不因此中止:没有 .env 也可能是把变量从别处注入的合法部署,
  # 而数据本身仍然是好的。但必须**响亮地**记下来,不能让它静默缺失。
  ENV_STATE="missing"
  echo "⚠️ 找不到 .env —— 这份备份不含配置快照,只靠它重建不出完整部署"
fi
chmod 700 "$DEST"

# ---------- 4. manifest ----------
echo "==> 记录对账快照"
{
  echo "stamp=$STAMP"
  echo "database=$PG_DB"
  echo "env_snapshot=$ENV_STATE"
  echo "db_bytes=$(wc -c < "$DEST/db.dump")"
  echo "uploads_bytes=$(wc -c < "$DEST/uploads.tar.gz")"
  echo "counts:"
  # 精确行数。
  # ⚠️ 不用 pg_stat_user_tables.n_live_tup —— 那是统计估算值,由 autovacuum 更新,
  #    恢复到一个新库之后不可比,会让 restore-drill 报出假失败(详见该脚本的注释)。
  for t in $(docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -X -A -t \
             -c "select tablename from pg_tables where schemaname='public' order by tablename;" \
             | tr -d '\r'); do
    [[ -z "$t" ]] && continue
    n=$(docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -X -A -t \
        -c "select count(*) from \"$t\";" | tr -d '[:space:]')
    echo "  $t=$n"
  done
} > "$DEST/manifest.txt"

cat "$DEST/manifest.txt"

# 到这里才算真的完成 —— 上面那个 trap 放行
FINISHED=1

echo
echo "✅ 备份完成:$DEST"
echo "   恢复演练:./scripts/restore-drill.sh $STAMP"
echo "   ⚠️ 记得把它同步到异地 —— 留在同一块磁盘上等于没有备份。"
