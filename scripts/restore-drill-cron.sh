#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 每周恢复演练的**入口**(给 cron 用)
#
# crontab:
#   30 5 * * 0 /home/ubuntu/knowledgeCool/scripts/restore-drill-cron.sh
#
# 为什么不每天做:真演练要把整库恢复到临时库,比备份本身重;
# 而每天那份轻校验(backup-cron.sh 里的 `pg_restore --list`)只能证明
# **归档没坏**,证明不了**能恢复**。两者分工:
#
#   每天 —— 备份 + 轻校验(归档可读)
#   每周 —— 真演练(恢复到临时库,逐表比对行数)
#
# ⚠️ 真演练必须做,而且不能只信"演练脚本会自己检查干净":
#    本仓库真的发生过 `restore-drill` 一路 ✅、真恢复却断在附件那一步的事
#    (见 DESIGN.md §9.5.3 第 2 条)—— 因为演练没覆盖到那一步。
#    演练的价值取决于它**覆盖了什么**,而不是它有没有通过。
# ============================================================
set -uo pipefail

# Windows(Git Bash / MSYS)上手工跑时也要能用 —— 见 backup.sh 的说明。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# cron 的 PATH 极简,docker 往往不在里面(见 backup-cron.sh 的详细说明)
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi
PG_USER="${POSTGRES_USER:-knowledgecool}"

LOG="${KC_BACKUP_LOG:-$HOME/knowledgecool-backup.log}"
BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# 取**最近一份**备份来演练 —— 出事时你真正会去恢复的就是它。
STAMP="$(ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}$' | sort | tail -1)"

log "===== 恢复演练开始(kind=drill) ====="

if [ -z "$STAMP" ]; then
  log "❌ 没有任何备份可以演练 —— 检查 backup-cron.sh 是不是一直在失败"
  exit 1
fi

# ---------- 先清掉以前演练失败留下的临时库 ----------
# restore-drill 正常结束会自己 drop 掉临时库;中途失败则会留下 drill_* 库。
# 每周一次、失败了又没人看,这些库会一直攒 —— 攒到最后把磁盘占了,
# 而它们没有任何用处。所以每次开跑前先扫一遍。
leftovers="$(docker compose exec -T postgres psql -U "$PG_USER" -d postgres -X -A -t \
  -c "select datname from pg_database where datname like 'drill\\_%';" < /dev/null 2>/dev/null | tr -d '\r')"
for db in $leftovers; do
  [ -z "$db" ] && continue
  docker compose exec -T postgres psql -U "$PG_USER" -d postgres -X \
    -c "drop database if exists \"$db\";" < /dev/null >/dev/null 2>&1 \
    && log "   清理残留临时库:$db"
done

# ---------- 演练 ----------
if out="$(./scripts/restore-drill.sh "$STAMP" 2>&1)"; then
  log "✅ 演练通过:$STAMP —— 这份备份**确实能恢复**,十张表行数逐条一致"
  printf '%s\n' "$out" | grep -E '✓' | sed 's/^/    /' >> "$LOG"
else
  rc=$?
  log "❌ 演练失败:$STAMP —— **这份备份恢复不了**,别依赖它"
  printf '%s\n' "$out" | tail -30 | sed 's/^/    /' >> "$LOG"
  exit "$rc"
fi

log "===== 恢复演练结束 ====="
exit 0
