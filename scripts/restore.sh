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
docker compose exec -T api sh -c 'rm -rf /data/uploads/* && tar -xzf - -C /data/uploads' \
  < "$SRC/uploads.tar.gz"

echo "==> 重新应用迁移(保证 schema 与当前代码一致)"
docker compose start api >/dev/null

echo
echo "✅ 恢复完成。建议做三件事:"
echo "   1. docker compose ps        —— 确认四个容器都 healthy"
echo "   2. curl -s localhost:\${WEB_PORT:-8080}/api/v1/health/ready"
echo "   3. 登录后抽查几篇文档与附件图片是否正常"
