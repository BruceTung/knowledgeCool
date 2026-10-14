#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 构建缓存闸门(给 cron 用;DESIGN.md §9.6)
#
# 为什么要有它:构建缓存会**随每次部署的镜像重建而累积** —— 2026-10-14
# 实测它涨到了 18.4 GB,是全机最大的可回收空间(这台机器磁盘才 100 GB)。
# 但它**同时是有用的**:有缓存,下一次部署才走增量,重建快得多。
# 所以策略不是"定期清空",而是**设上限、超了才削** ——
# 平时一动不动;失控时也只削到上限以内(按最久未用淘汰,不整仓清空)。
#
# crontab(每天 04:45 —— 抢在 05:00 备份之前跑。理由:万一哪天缓存真把
# 磁盘挤满,备份脚本自己的「磁盘余量守卫」会拒绝备份;先削缓存、再备份,
# 顺序才是对的):
#   45 4 * * * /home/ubuntu/knowledgeCool/scripts/builder-prune-cron.sh
#
# 环境变量(都可不设):
#   BUILDER_CACHE_MAX      缓存上限,默认 8GB(原样传给 --max-used-space)
#   KC_BUILDER_PRUNE_LOG   日志路径,默认 $HOME/knowledgecool-builder-prune.log
# ============================================================
set -uo pipefail

# Windows(Git Bash / MSYS)上手工跑时也要能用 —— 见 backup.sh 的说明。
# cron 跑在 Linux 上,这两行等于无操作。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# ⚠️ cron 的 PATH 极简(通常只有 /usr/bin:/bin),docker 往往不在里面 ——
#    详见 backup-cron.sh 顶部。不补 PATH 的定时任务会以
#    `docker: command not found` 静默失败,而手工跑同一行却是好的。
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

MAX="${BUILDER_CACHE_MAX:-8GB}"
LOG="${KC_BUILDER_PRUNE_LOG:-$HOME/knowledgecool-builder-prune.log}"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# 当前缓存大小 —— **只用于日志**("before → after" 看得见)。
# 判定不在这里:真正的闸门是 buildx 自己的 GC 策略(--max-used-space)。
# 所以它读不到时记「未知」即可 —— 观测行为绝不能把脚本弄挂。
cache_size() {
  docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null \
    | awk -F'|' '$1=="Build Cache"{print $2; exit}'
}

BEFORE="$(cache_size)"

# 闸门本体:上限以内什么都不做;超限时削到上限以内。
# 没有可回收内容时输出 `Total: 0B` —— 那也是成功,不是错误。
OUT="$(docker builder prune --max-used-space "$MAX" -f 2>&1)"
RC=$?

AFTER="$(cache_size)"
TOTAL="$(printf '%s\n' "$OUT" | grep -i '^Total' | tail -1)"

if [[ "$RC" -ne 0 ]]; then
  log "❌ prune 失败(exit $RC):$(printf '%s' "$OUT" | tail -2 | tr '\n' ' ')"
  exit "$RC"
fi

log "构建缓存闸门:before=${BEFORE:-未知} after=${AFTER:-未知}(上限 $MAX${TOTAL:+;$TOTAL})"
