#!/bin/bash
# post-tool-hook.sh — PostToolUse hook: streams tool calls into a single Telegram message.
# Each task gets one "activity" message that gets edited in-place as tools are called.
# Message is auto-deleted after STREAM_TTL seconds of inactivity.
# Claude Code calls this after every tool use, passing JSON via stdin.

set -euo pipefail

# Load credentials
if [ -f /root/relay/.env ]; then
  source <(grep -E '^(TELEGRAM_BOT_TOKEN|GROUP_CHAT_ID)=' /root/relay/.env)
fi

THREAD_ID="${TELEGRAM_THREAD_ID:-}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${GROUP_CHAT_ID:-}"
STREAM_TTL=120   # seconds of inactivity before clearing the stream message

# Abort silently if not configured
[ -z "$THREAD_ID" ] || [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ] && exit 0

# Read JSON from stdin
INPUT="$(cat)"

TOOL_NAME="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name','?'))" 2>/dev/null || echo '?')"
TOOL_INPUT="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('tool_input',{})))" 2>/dev/null || echo '{}')"

# Only report action tools — skip noisy read-only file ops
case "$TOOL_NAME" in
  mcp__telegram__*|Read|Glob|Grep)
    exit 0
    ;;
  Bash)
    CMD="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('command','')[:120])" 2>/dev/null || echo '')"
    case "$CMD" in
      *"docker inspect"*|*"docker logs"*|*"tmux capture"*|*"tmux -S"*|*"docker exec"*"tmux"*|*"tail -"*"/tmp/"*|*"cat /tmp/"*)
        exit 0 ;;
    esac
    ENTRY="🔧 <code>${CMD}</code>"
    ;;
  Edit)
    FILE="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('file_path',''))" 2>/dev/null || echo '')"
    ENTRY="✏️ <code>${FILE}</code>"
    ;;
  Write)
    FILE="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('file_path',''))" 2>/dev/null || echo '')"
    ENTRY="💾 <code>${FILE}</code>"
    ;;
  WebFetch|WebSearch)
    URL="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('url',d.get('query',''))[:80])" 2>/dev/null || echo '')"
    ENTRY="🌐 <code>${URL}</code>"
    ;;
  Agent)
    DESC="$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('description','')[:60])" 2>/dev/null || echo '')"
    ENTRY="🤖 Agent: <code>${DESC}</code>"
    ;;
  *)
    ENTRY="⚙️ <b>${TOOL_NAME}</b>"
    ;;
esac

# State file: stores message_id + last_ts + accumulated lines
STREAM_STATE="/tmp/tg-tool-stream-${THREAD_ID}"
NOW=$(date +%s)

(
  # Serialize concurrent writes with a lock
  exec 9>"/tmp/tg-tool-stream-${THREAD_ID}.lock"
  flock -w 2 9 || exit 0

  MSG_ID=""
  LINES=""
  LAST_TS=0

  if [ -f "$STREAM_STATE" ]; then
    MSG_ID=$(python3 -c "import json; d=json.load(open('$STREAM_STATE')); print(d.get('msg_id',''))" 2>/dev/null || echo '')
    LAST_TS=$(python3 -c "import json; d=json.load(open('$STREAM_STATE')); print(d.get('ts',0))" 2>/dev/null || echo 0)
    LINES=$(python3 -c "import json; d=json.load(open('$STREAM_STATE')); print(d.get('lines',''))" 2>/dev/null || echo '')
  fi

  # If TTL expired, start fresh (delete old message if exists)
  if [ -n "$MSG_ID" ] && [ $(( NOW - LAST_TS )) -gt "$STREAM_TTL" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage" \
      -d chat_id="${CHAT_ID}" \
      -d message_id="${MSG_ID}" > /dev/null 2>&1 || true
    MSG_ID=""
    LINES=""
  fi

  # Append new entry (keep last 10 lines)
  if [ -n "$LINES" ]; then
    LINES="${LINES}
${ENTRY}"
  else
    LINES="${ENTRY}"
  fi
  # Keep last 10 entries
  LINES=$(echo "$LINES" | tail -10)

  HEADER="⚙️ <b>עובד...</b>"
  FULL_TEXT="${HEADER}
${LINES}"

  if [ -z "$MSG_ID" ]; then
    # Send new message
    RESULT=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="${CHAT_ID}" \
      -d message_thread_id="${THREAD_ID}" \
      -d parse_mode=HTML \
      --data-urlencode "text=${FULL_TEXT}" 2>/dev/null || echo '{}')
    MSG_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('result',{}).get('message_id',''))" 2>/dev/null || echo '')
  else
    # Edit existing message
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/editMessageText" \
      -d chat_id="${CHAT_ID}" \
      -d message_id="${MSG_ID}" \
      -d parse_mode=HTML \
      --data-urlencode "text=${FULL_TEXT}" > /dev/null 2>&1 || true
  fi

  # Save state (write lines to temp file to avoid quoting issues)
  printf '%s' "$LINES" > "${STREAM_STATE}.lines"
  python3 - <<PYEOF 2>/dev/null || true
import json
lines = open('${STREAM_STATE}.lines').read()
json.dump({'msg_id': '${MSG_ID}', 'ts': ${NOW}, 'lines': lines}, open('${STREAM_STATE}', 'w'))
PYEOF

) &

exit 0
