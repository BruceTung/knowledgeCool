#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 备份恢复演练(DESIGN.md §9 M6 的「恢复演练脚本」)
#
# 为什么必须有这个脚本:**没演练过的备份等于没有备份。**
# 它把备份恢复到一个**临时数据库**(名字带 `drill_` 前缀),
# 逐表精确比对行数,然后删掉临时库 —— 全程不碰生产库。
#
# 用法:
#   ./scripts/restore-drill.sh                  # 演练最近一次备份
#   ./scripts/restore-drill.sh 20260926-120000  # 演练指定的一次
#
# 通过后再用 ./scripts/restore.sh 做真正的恢复。
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

if [[ -z "$STAMP" || ! -d "$BACKUP_ROOT/$STAMP" ]]; then
  echo "❌ 找不到备份:$BACKUP_ROOT/$STAMP"
  echo "   先跑 ./scripts/backup.sh"
  exit 1
fi

SRC="$BACKUP_ROOT/$STAMP"
DRILL_DB="drill_${STAMP//[^0-9]/_}"
PSQL=(docker compose exec -T postgres psql -U "$PG_USER" -X)

echo "==> 演练备份:$STAMP"
echo "==> 临时库:$DRILL_DB"

cleanup() {
  echo "==> 清理临时库"
  "${PSQL[@]}" -d postgres -c "drop database if exists \"$DRILL_DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------- 1. 建临时库并恢复 ----------
"${PSQL[@]}" -d postgres -c "drop database if exists \"$DRILL_DB\";" >/dev/null
"${PSQL[@]}" -d postgres -c "create database \"$DRILL_DB\";" >/dev/null
# 扩展必须先在,否则 dump 里的 gin_trgm_ops 索引建不起来
"${PSQL[@]}" -d "$DRILL_DB" -c 'create extension if not exists "citext";' >/dev/null
"${PSQL[@]}" -d "$DRILL_DB" -c 'create extension if not exists "pg_trgm";' >/dev/null

echo "==> 恢复数据"
if ! docker compose exec -T postgres \
  pg_restore -U "$PG_USER" -d "$DRILL_DB" --no-owner --no-privileges \
  < "$SRC/db.dump" >/dev/null 2>&1; then
  # pg_restore 对「扩展已存在」之类的警告会返回非零,不能一律当失败 ——
  # 真正的判据是下面那一步的行数比对。
  echo "   (pg_restore 返回了非零退出码,继续用行数比对判定)"
fi

# ---------- 2. 逐表比对行数 ----------
#
# ⚠️ 必须用 `count(*)`。第一版用的是 pg_stat_user_tables.n_live_tup ——
# 那是**统计估算值**,由 autovacuum 更新,在一次全新的恢复之后与生产库根本不可比。
# 它会让演练报出假失败(「备份坏了」),而假失败比没有演练更糟:
# 要么让人对好备份失去信任,要么让人对真问题麻木。
#
# 这个错误是被实际跑出来的:第一次在服务器上演练时报 audit_logs 生产=71 恢复后=61,
# 而备份本身完全正常。
echo "==> 逐表精确比对行数(count(*),不用 n_live_tup 估算值)"
TABLES="$("${PSQL[@]}" -d "$PG_DB" -A -t \
  -c "select tablename from pg_tables where schemaname='public' order by tablename;" | tr -d '\r')"

fail=0
for table in $TABLES; do
  [[ -z "$table" ]] && continue

  source_count="$("${PSQL[@]}" -d "$PG_DB" -A -t \
    -c "select count(*) from \"$table\";" | tr -d '[:space:]')"
  drill_count="$("${PSQL[@]}" -d "$DRILL_DB" -A -t \
    -c "select count(*) from \"$table\";" 2>/dev/null | tr -d '[:space:]')"
  [[ -z "$drill_count" ]] && drill_count='缺失'

  if [[ "$drill_count" == "$source_count" ]]; then
    printf '  ✓ %-22s %s\n' "$table" "$source_count"
  else
    printf '  ✗ %-22s 生产=%s 恢复后=%s\n' "$table" "$source_count" "$drill_count"
    fail=1
  fi
done

# ---------- 3. 附件包可读性 ----------
echo "==> 校验附件包"
if tar -tzf "$SRC/uploads.tar.gz" >/dev/null 2>&1; then
  echo "  ✓ uploads.tar.gz 可正常解包($(tar -tzf "$SRC/uploads.tar.gz" | wc -l) 个条目)"
else
  echo "  ✗ uploads.tar.gz 损坏"
  fail=1
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo "✅ 演练通过 —— 这份备份是**能恢复的**,不是躺在磁盘上的死文件。"
else
  echo "❌ 演练失败 —— 别依赖这份备份,先查清原因。"
  exit 1
fi
