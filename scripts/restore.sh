#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 从备份恢复(真实恢复,会覆盖当前数据)
#
# ⚠️ 这是**破坏性操作**:库会被 drop 再重建,附件目录会被清空重填。
#    脚本会要求你输入 yes 确认,不接受 -y 之类的绕过参数 ——
#    这种操作不该能被打包进自动化里悄悄跑。
#
# 恢复前建议先跑一次 restore-drill.sh,确认这份备份是可恢复的。
#
# 用法:
#   ./scripts/restore.sh                  # 用最近一次备份
#   ./scripts/restore.sh 20260926-120000
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

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

PG_USER="${POSTGRES_USER:-knowledgecool}"
PG_DB="${POSTGRES_DB:-knowledgecool}"
BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"

STAMP="${1:-}"
if [[ -z "$STAMP" ]]; then
  STAMP="$(ls -1 "$BACKUP_ROOT" 2>/dev/null | sort | tail -1 || true)"
fi

SRC="$BACKUP_ROOT/$STAMP"
if [[ -z "$STAMP" || ! -d "$SRC" ]]; then
  echo "❌ 找不到备份:$SRC"
  exit 1
fi

echo "============================================================"
echo " 即将用这份备份覆盖当前数据:"
echo "   备份:$SRC"
echo "   数据库:$PG_DB(将被 drop 并重建)"
echo "   附件:/data/uploads(将被清空并重填)"
echo "============================================================"
read -r -p "确认请输入 yes: " answer
if [[ "$answer" != "yes" ]]; then
  echo "已取消。"
  exit 1
fi

PSQL=(docker compose exec -T postgres psql -U "$PG_USER" -X)

echo "==> 停掉 api(避免恢复过程中有写入)"
docker compose stop api >/dev/null

echo "==> 重建数据库"
"${PSQL[@]}" -d postgres -c "drop database if exists \"$PG_DB\";" >/dev/null
"${PSQL[@]}" -d postgres -c "create database \"$PG_DB\";" >/dev/null
# 扩展必须先在,否则 dump 里的 gin_trgm_ops 索引建不起来
"${PSQL[@]}" -d "$PG_DB" -c 'create extension if not exists "citext";' >/dev/null
"${PSQL[@]}" -d "$PG_DB" -c 'create extension if not exists "pg_trgm";' >/dev/null

echo "==> 导入数据"
docker compose exec -T postgres \
  pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --no-privileges \
  < "$SRC/db.dump" >/dev/null 2>&1 || true

echo "==> 恢复附件"
# ⚠️ 这里**不能用 `docker compose exec`** —— 上面刚把 api 停掉了,exec 进不去
# 一个已停止的容器,会以 "service \"api\" is not running" 失败。
#
# 这不是理论问题:第一版就是 exec,实测**恢复链路真的断在这里**,
# 而且断在最坏的位置 —— 库已经被 drop 重建、数据也导进去了,只有附件没恢复、
# api 也没起来。也就是说"演练能过、真恢复会挂":
# restore-drill 只校验附件包能不能解(在宿主机上 tar -tzf),
# 从来不真的往容器里写,所以它看不到这个错。
#
# `compose run` 会**另起一个一次性容器**(挂同一批卷),不要求服务正在运行,
# 正好适合"在服务停着的时候往它的卷里写东西"。`--no-deps` 免得它再等一遍
# postgres/redis 的健康检查 —— 那两位此时本来就好好跑着。
docker compose run --rm -T --no-deps api \
  sh -c 'rm -rf /data/uploads/* && tar -xzf - -C /data/uploads' \
  < "$SRC/uploads.tar.gz"

echo "==> 重新应用迁移(保证 schema 与当前代码一致)"
docker compose start api >/dev/null

echo
echo "✅ 恢复完成。建议做三件事:"
echo "   1. docker compose ps        —— 确认四个容器都 healthy"
echo "   2. curl -s localhost:\${WEB_PORT:-8080}/api/v1/health/ready"
echo "   3. 登录后抽查几篇文档与附件图片是否正常"
