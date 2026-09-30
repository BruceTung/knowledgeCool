#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 每日备份的**入口**(给 cron 用)
#
# 用法(crontab):
#   0 5 * * * /home/ubuntu/knowledgeCool/scripts/backup-cron.sh
#
# 它自己不导数据 —— 导数据只有 backup.sh 那一份(§12)。这里只负责
# cron 才需要的那几件事:
#
#   1. 看磁盘余量。备份把磁盘写满会**把正在跑的服务一起拖垮**,
#      所以余量不够时宁可这次不备份。
#   2. 调 backup.sh,把它的输出原样收进日志(cron 里没人看得到 stdout)。
#   3. 校验新出来的 dump **是能读的** —— 这一步才让它从"跑完了"
#      变成"拿到了一份可用的备份"。⚠️ 它只证明归档没坏,
#      **不证明能恢复**;真正的证明在每周日的 restore-drill(见 crontab)。
#   4. 按保留期清理旧备份。没有这一步,备份会无限堆积。
#
# 环境变量(都可不设):
#   BACKUP_KEEP_DAYS    保留天数,默认 30
#   BACKUP_MIN_FREE_MB  最低磁盘余量(MB),默认 2048
#   KC_BACKUP_LOG       日志路径,默认 $HOME/knowledgecool-backup.log
# ============================================================
set -uo pipefail

# Windows(Git Bash / MSYS)上手工跑时也要能用 —— 见 backup.sh 的说明。
# cron 跑在 Linux 上,这两行等于无操作。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# ⚠️ cron 的 PATH 极简(通常只有 /usr/bin:/bin),docker 往往不在里面。
#    不补 PATH 的话,定时任务会以 `docker: command not found` 静默失败 ——
#    而手工在终端跑同一行命令却是好的(因为你的 shell 有完整 PATH)。
#    这是排查"cron 不执行"时最该先看的一条。
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG="${KC_BACKUP_LOG:-$HOME/knowledgecool-backup.log}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"
BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

log "===== 每日备份开始(kind=daily) ====="

# ---------- 1. 磁盘余量 ----------
avail_mb="$(df -Pm / | awk 'NR==2 {print $4}')"
if [ "${avail_mb:-0}" -lt "$MIN_FREE_MB" ]; then
  log "❌ 磁盘余量不足(${avail_mb}MB < ${MIN_FREE_MB}MB),本次跳过"
  log "   备份把磁盘写满会连带拖垮服务,宁可这一次不备份。请清理磁盘。"
  exit 1
fi

# ---------- 2. 备份 ----------
if out="$(./scripts/backup.sh 2>&1)"; then
  log "✅ backup.sh 完成"
  printf '%s\n' "$out" | grep -E '备份目标|db_bytes|uploads_bytes|env_snapshot|✅|⚠️' | sed 's/^/    /' >> "$LOG"
else
  rc=$?
  log "❌ backup.sh 失败(退出码 $rc)—— **这次没有产生可用备份**"
  printf '%s\n' "$out" | sed 's/^/    /' >> "$LOG"
  exit "$rc"
fi

# ---------- 3. 校验新备份可读 ----------
NEW="$(ls -1 "$BACKUP_ROOT" 2>/dev/null | sort | tail -1)"
if [ -z "$NEW" ]; then
  log "❌ 备份目录里找不到刚生成的备份"
  exit 1
fi
DEST="$BACKUP_ROOT/$NEW"

if docker compose exec -T postgres pg_restore --list < "$DEST/db.dump" >/dev/null 2>&1; then
  log "✅ $NEW:dump 可读,附件包 $( [ -s "$DEST/uploads.tar.gz" ] && echo 非空 || echo '**为空**' )"
else
  log "❌ $NEW:dump **读不出来** —— 这份备份不可信,不要依赖它。"
  log "   已保留现场供排查:$DEST"
  exit 1
fi

# ---------- 4. 清理旧备份 ----------
# 只删**名字长得像备份目录**的(YYYYMMDD-HHMMSS),别的一律不碰 ——
# 万一 BACKUP_ROOT 指到了某个还有别的东西的目录,rm -rf 不该在那里撒野。
pruned=0
for d in "$BACKUP_ROOT"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  case "$name" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) continue ;;
  esac
  if [ -n "$(find "$d" -maxdepth 0 -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then
    rm -rf "$d"
    pruned=$((pruned + 1))
  fi
done
kept="$(ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -cE '^[0-9]{8}-[0-9]{6}$')"
log "保留期 ${KEEP_DAYS} 天:清理 $pruned 份,现存 ${kept} 份,占用 $(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)"

# ---------- 5. 日志自剪 ----------
# 日志本身涨得太快会变成新的运维负担。留最近 3000 行足够回溯。
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 3000 ]; then
  tail -n 3000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

log "===== 每日备份结束 ====="
exit 0
