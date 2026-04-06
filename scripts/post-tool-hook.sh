#!/bin/bash
# post-tool-hook.sh — PostToolUse hook: sends tool call summary to Telegram.
# Claude Code calls this after every tool use, passing JSON via stdin.
# Env: TELEGRAM_THREAD_ID, TELEGRAM_BOT_TOKEN (or reads from .env)

set -euo pipefail

# Load credentials
if [ -f /root/relay/.env ]; then
  source <(grep -E '^(TELEGRAM_BOT_TOKEN|GROUP_CHAT_ID)=' /root/relay/.env)
fi

THREAD_ID="${TELEGRAM_THREAD_ID:-}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${GROUP_CHAT_ID:-}"

# Abort silently if not configured
[ -z "$THREAD_ID" ] || [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ] && exit 0

# Read JSON from stdin
INPUT="$(cat)"

TOOL_NAME="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name','?'))" 2>/dev/null || echo '?')"
TOOL_INPUT="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('tool_input',{})))" 2>/dev/null || echo '{}')"

# Only report action tools — skip noisy read-only file ops
case "$TOOL_NAME" in
  mcp__telegram__*|Read|Glob|Grep)
    # Silent — too noisy, low signal
    exit 0
    ;;
  Bash)
    CMD="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('command','')[:150])" 2>/dev/null || echo '')"
    MSG="🔧 <b>Bash</b> <code>${CMD}</code>"
    ;;
  Edit)
    FILE="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('file_path',''))" 2>/dev/null || echo '')"
    MSG="✏️ <b>Edit</b> <code>${FILE}</code>"
    ;;
  Write)
    FILE="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('file_path',''))" 2>/dev/null || echo '')"
    MSG="💾 <b>Write</b> <code>${FILE}</code>"
    ;;
  WebFetch|WebSearch)
    URL="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('url',d.get('query',''))[:100])" 2>/dev/null || echo '')"
    MSG="🌐 <b>${TOOL_NAME}</b> <code>${URL}</code>"
    ;;
  *)
    MSG="⚙️ <b>${TOOL_NAME}</b>"
    ;;
esac

# Send in background so it never blocks Claude
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d message_thread_id="${THREAD_ID}" \
  -d parse_mode=HTML \
  --data-urlencode "text=${MSG}" \
  > /dev/null 2>&1 &

exit 0
