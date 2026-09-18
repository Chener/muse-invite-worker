#!/usr/bin/env bash
#
# deploy.sh — 在 Mac 上部署 muse-invite-v2 Worker 到 Cloudflare
#
# 用法：  ./deploy.sh
#   可选环境变量：
#     CLOUDFLARE_TOKEN_FILE  token 文件路径（默认 $HOME/.config/muse-bot/cloudflare_token）
#     WORKER_NAME            worker 名（默认 muse-invite-v2）
#     KV_TITLE               KV namespace 名（默认 muse-invite-v2）
#
# 行为（幂等，可反复重跑）：
#   1. 从 token 文件读 API token（只读不打印；文件应为 0600）
#   2. 自动发现 account ID（取该 token 可见的第一个账号）
#   3. KV namespace 按名查找，不存在则创建
#   4. 上传 worker.js 并绑定 KV（PUT = upsert，重跑即更新）
#   5. 输出 worker 域名 + 冒烟测试
#
# 注意：token 只存在于本机文件与本次进程内存中，不打印、不写日志、不进 git。

set -uo pipefail

TOKEN_FILE="${CLOUDFLARE_TOKEN_FILE:-$HOME/.config/muse-bot/cloudflare_token}"
WORKER_NAME="${WORKER_NAME:-muse-invite-v2}"
KV_TITLE="${KV_TITLE:-muse-invite-v2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://api.cloudflare.com/client/v4"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*" >&2; }

# ---------- 0. 读 token（只读不打印） ----------
[ -f "$TOKEN_FILE" ] || die "token 文件不存在: $TOKEN_FILE（请先按 Secure Vault 卡片把 Cloudflare API token 存到该文件，权限 0600）"
perms="$(stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || stat -c '%a' "$TOKEN_FILE" 2>/dev/null || echo "?")"
[ "$perms" = "600" ] || echo "WARN: token 文件权限为 $perms，建议 chmod 600 $TOKEN_FILE" >&2
TOKEN="$(cat "$TOKEN_FILE")"
[ -n "$TOKEN" ] || die "token 文件为空: $TOKEN_FILE"
[ -f "$SCRIPT_DIR/worker.js" ] || die "找不到 $SCRIPT_DIR/worker.js（请在仓库根目录运行）"

AUTH_HEADER="Authorization: Bearer $TOKEN"
cf_get()  { curl -sS -m 30 -H "$AUTH_HEADER" "$@"; }
cf_post() { curl -sS -m 30 -X POST -H "$AUTH_HEADER" -H "Content-Type: application/json" "$@"; }

# ---------- 1. 自动发现 account ID ----------
info "发现 Cloudflare account…"
ACCT_JSON="$(cf_get "$API/accounts")" || die "请求 /accounts 失败（网络或 token 无效）"
ACCOUNT_ID="$(echo "$ACCT_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
r=d.get("result") or []
print(r[0]["id"] if d.get("success") and r else "")
')"
ACCT_NAME="$(echo "$ACCT_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
r=d.get("result") or []
print(r[0]["name"] if d.get("success") and r else "")
')"
[ -n "$ACCOUNT_ID" ] || die "无法解析 account ID，响应：$(echo "$ACCT_JSON" | head -c 300)"
info "account: ${ACCT_NAME} (${ACCOUNT_ID})"

# ---------- 2. workers.dev 子域名 ----------
info "查询 workers.dev 子域名…"
SUBDOMAIN="$(cf_get "$API/accounts/$ACCOUNT_ID/workers/subdomain" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(d.get("result",{}).get("subdomain") or "")
')"
[ -n "$SUBDOMAIN" ] || die "无法获取 workers subdomain（该账号可能未启用 Workers）"
info "workers.dev subdomain: ${SUBDOMAIN}"

# ---------- 3. KV namespace：按名查找，不存在则创建 ----------
info "查找 KV namespace「${KV_TITLE}」…"
NS_LIST="$(cf_get "$API/accounts/$ACCOUNT_ID/storage/kv/namespaces")" || die "列出 KV namespaces 失败"
NS_ID="$(KV_TITLE="$KV_TITLE" echo "$NS_LIST" | python3 -c '
import json,sys,os
d=json.load(sys.stdin)
want=os.environ["KV_TITLE"]
ns=[n for n in (d.get("result") or []) if n.get("title")==want]
print(ns[0]["id"] if ns else "")
')"
if [ -z "$NS_ID" ]; then
  info "不存在，创建 KV namespace…"
  NS_ID="$(cf_post --data "$(python3 -c 'import json,os; print(json.dumps({"title": os.environ["KV_TITLE"]}))')" \
    "$API/accounts/$ACCOUNT_ID/storage/kv/namespaces" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(d.get("result",{}).get("id") or "")
')"
  [ -n "$NS_ID" ] || die "创建 KV namespace 失败"
  info "已创建 namespace: ${NS_ID}"
else
  info "已存在 namespace: ${NS_ID}（复用，不重建）"
fi

# ---------- 4. 上传 worker（含 KV 绑定；PUT 即 upsert） ----------
info "上传 worker「${WORKER_NAME}」（绑定 KV=${NS_ID}）…"
METADATA="$(python3 - "$WORKER_NAME" "$NS_ID" <<'EOF'
import json,sys
name, ns = sys.argv[1], sys.argv[2]
print(json.dumps({
  "main_module": "worker.js",
  "compatibility_date": "2026-09-01",
  "bindings": [{"type": "kv_namespace", "name": "KV", "namespace_id": ns}],
}))
EOF
)"
UPLOAD_RESP="$(curl -sS -m 60 -X PUT -H "$AUTH_HEADER" \
  -F "metadata=${METADATA};type=application/json" \
  -F "worker.js=@${SCRIPT_DIR}/worker.js;type=application/javascript+module" \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME")"
UPLOAD_OK="$(echo "$UPLOAD_RESP" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("yes" if d.get("success") else "no")
')"
[ "$UPLOAD_OK" = "yes" ] || die "上传 worker 失败：$(echo "$UPLOAD_RESP" | head -c 500)"
info "worker 上传成功"

# ---------- 5. 输出域名 + 冒烟测试 ----------
WORKER_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
echo ""
echo "WORKER_URL=${WORKER_URL}"
echo "API 示例: ${WORKER_URL}/api/codes"
echo ""
info "冒烟测试 GET /api …"
SMOKE="$(curl -sS -m 30 "${WORKER_URL}/api")"
echo "$SMOKE" | python3 -c '
import json,sys
d=json.load(sys.stdin)
eps=d.get("endpoints",[])
print("smoke OK:", d.get("name"), "| endpoints:", len(eps))
' || { echo "WARN: 冒烟测试未返回预期 JSON，请检查上面输出" >&2; }

echo ""
echo "下一步（总协调员）：把前端分支 feat/worker-v2 上 assets/worker-v2.js 中的"
echo "WORKER_URL_PLACEHOLDER 替换为：${WORKER_URL}"
