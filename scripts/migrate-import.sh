#!/usr/bin/env bash
# ============================================================
# 知源 KnowledgeCool · 全量数据迁移 —— **导入端**
#
# 把 migrate-export.sh 产出的整包恢复到**这台**机器上。
#
# 用法:
#   ./scripts/migrate-import.sh knowledgecool-migrate-20260930-191620.tar.gz
#
# 做四件事,顺序不能颠倒:
#   1. 校验 SHA256SUMS —— **先证明这个包没坏、没被改**,再动现有数据
#   2. 解开到 ./backups/<时间戳>/(restore.sh 认这个布局)
#   3. 交给 restore.sh 恢复(恢复逻辑只允许存在一份,§12)
#   4. 逐表比对行数 —— 与包里的 manifest 对账
#
# ⚠️ 这是**破坏性操作**:当前库会被 drop 再重建。脚本要求输入 yes 确认,
#    并且**在校验和通过之前不会碰任何现有数据**。
# ============================================================
set -euo pipefail

# ⚠️ Windows(Git Bash / MSYS)必须关掉路径自动翻译 —— 见 backup.sh 里的详细说明。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUNDLE="${1:-}"
if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "❌ 用法:./scripts/migrate-import.sh <迁移包.tar.gz>"
  [[ -n "$BUNDLE" ]] && echo "   找不到文件:$BUNDLE"
  exit 1
fi
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"

if [[ ! -f .env ]]; then
  echo "❌ 找不到 .env。请先 `cp env.from-source .env`(从包里拿),再跑本脚本。"
  exit 1
fi

BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "==> 1/4 解开并校验"
tar -xzf "$BUNDLE" -C "$TMP"
# 包里只有一个顶层目录(时间戳);用循环取第一个,避免 ls 解析歧义
STAMP=""
for d in "$TMP"/*/; do STAMP="$(basename "$d")"; break; done
if [[ -z "$STAMP" || ! -f "$TMP/$STAMP/db.dump" ]]; then
  echo "❌ 这个包的结构不对(缺少 <时间戳>/db.dump)"
  exit 1
fi
SRC="$TMP/$STAMP"

echo "    来源信息:"
sed 's/^/      /' "$SRC/source-info.txt" 2>/dev/null || echo "      (包内没有 source-info.txt)"

echo "    校验和:"
if ( cd "$SRC" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ); then
  echo "      ✓ 全部匹配 —— 这个包是完整的"
else
  echo "      ✗ 校验和不匹配:**这个包已经损坏或被改动过**。"
  echo "        已中止,没有碰任何现有数据。"
  ( cd "$SRC" && sha256sum -c SHA256SUMS 2>&1 | sed 's/^/        /' ) || true
  exit 1
fi

# 版本提示:代码版本对不上时 schema 可能不一致
LOCAL_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo '')"
SRC_COMMIT="$(sed -n 's/^repo_commit=//p' "$SRC/source-info.txt" 2>/dev/null || echo '')"
if [[ -n "$LOCAL_COMMIT" && -n "$SRC_COMMIT" && "$LOCAL_COMMIT" != "$SRC_COMMIT" ]]; then
  echo
  echo "⚠️ 代码版本不一致:"
  echo "     本机   :$LOCAL_COMMIT"
  echo "     来源机 :$SRC_COMMIT"
  echo "   迁移通常仍可完成(恢复后 api 会自动跑 migrate deploy),"
  echo "   但如果两边 schema 差得远,请先把代码切到来源机的 commit 再导。"
  echo
fi

echo "==> 2/4 放到 restore.sh 认的布局"
mkdir -p "$BACKUP_ROOT"
if [[ -e "$BACKUP_ROOT/$STAMP" ]]; then
  echo "    ⚠️ $BACKUP_ROOT/$STAMP 已存在,将被这次的覆盖"
  rm -rf "$BACKUP_ROOT/$STAMP"
fi
mkdir -p "$BACKUP_ROOT/$STAMP"
cp "$SRC/db.dump" "$SRC/uploads.tar.gz" "$SRC/manifest.txt" "$BACKUP_ROOT/$STAMP/"

echo "==> 3/4 交给 restore.sh 恢复(它会要求输入 yes 确认)"
./scripts/restore.sh "$STAMP"

echo "==> 4/4 与包里的 manifest 对账"
PSQL=(docker compose exec -T postgres psql -U "${POSTGRES_USER:-knowledgecool}" -X)
PG_DB="${POSTGRES_DB:-knowledgecool}"

# manifest.txt 里的行数形如 "  users=5"
#
# ⚠️ `psql` 那一行必须带 `< /dev/null`。
#
# 这个 while 循环的 stdin 是 manifest.txt —— 而 `docker compose exec -T` 默认
# **继承 stdin**,psql 会把剩下的 manifest 全读走当作输入。于是循环只跑了第一张表
# 就结束,然后打印"行数与源包完全一致"。
#
# 这是最坏的一类 bug:一个**看起来在核对、实际只核对了一行**的检查。
# 第一版就是这样 —— 输出里只有 `✓ _prisma_migrations 4` 一行,
# 断言却写着"完全一致"。把 stdin 切断之后它才会真的逐表比对。
fail=0
while IFS= read -r line; do
  case "$line" in
    "  "*=*) ;;
    *) continue ;;
  esac
  table="${line%%=*}"; table="${table#  }"
  want="${line##*=}"
  got="$("${PSQL[@]}" -d "$PG_DB" -A -t -c "select count(*) from \"$table\";" < /dev/null | tr -d '[:space:]')"
  if [[ "$got" == "$want" ]]; then
    printf '  ✓ %-22s %s\n' "$table" "$got"
  else
    printf '  ✗ %-22s 包里=%s 导入后=%s\n' "$table" "$want" "$got"
    fail=1
  fi
done < "$SRC/manifest.txt"

echo
if [[ "$fail" -eq 0 ]]; then
  echo "✅ 迁移完成 —— 行数与源包完全一致。"
  echo
  echo "   建议再确认三件事:"
  echo "     1. docker compose ps                       —— 四个容器都 healthy"
  echo "     2. curl -s localhost:${WEB_PORT:-8080}/api/v1/health/ready"
  echo "     3. 用原来的账号登录,抽查几篇文档与附件图片"
  echo
  echo "   ⚠️ 附件是 Nginx 直出的静态文件。若换了 WEB_PORT/域名,"
  echo "      已经写进正文里的图片地址仍然是旧的 —— 那属于内容,不在迁移范围。"
else
  echo "❌ 行数对不上 —— 先别切流量,查清原因(见上面的 ✗ 行)。"
  exit 1
fi
