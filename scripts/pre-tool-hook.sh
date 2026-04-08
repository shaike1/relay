#!/bin/bash
# pre-tool-hook.sh — PreToolUse hook: blocks dangerous operations and asks for Telegram approval.
# Reads JSON from stdin (Claude Code PreToolUse hook format).
# For dangerous commands: sends Telegram buttons and WAITS for approval (up to 5 min).
# Exits 0 to allow, 2 to block.
set -euo pipefail

# Load credentials from .env
BOT_TOKEN=""
CHAT_ID=""
if [ -f /root/relay/.env ]; then
  BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1)
  CHAT_ID=$(grep -E '^GROUP_CHAT_ID=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1)
fi

THREAD_ID="${TELEGRAM_THREAD_ID:-}"
SESSION="${SESSION_NAME:-unknown}"

# Read the hook JSON from stdin
HOOK_JSON=$(cat)

# Extract tool name and input
TOOL_NAME=$(echo "$HOOK_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$HOOK_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('tool_input','')))" 2>/dev/null || echo "{}")

# --- Audit log (always, before safety check) ---
if [ -n "$THREAD_ID" ]; then
  AUDIT_FILE="/tmp/relay-audit-${THREAD_ID}.jsonl"
  TS=$(date +%s)
  AUDIT_ENTRY=$(python3 -c "
import sys, json
tool = sys.argv[1]
input_json = sys.argv[2]
thread_id = sys.argv[3]
ts = int(sys.argv[4])
try:
  inp = json.loads(input_json)
except:
  inp = input_json
entry = {'ts': ts, 'thread_id': thread_id, 'tool': tool, 'input': inp, 'user': 'claude'}
print(json.dumps(entry))
" "$TOOL_NAME" "$TOOL_INPUT" "$THREAD_ID" "$TS" 2>/dev/null || echo "{}")
  echo "$AUDIT_ENTRY" >> "$AUDIT_FILE" 2>/dev/null || true
fi

# --- Safety check (only for Bash tool) ---
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$HOOK_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

# Check for dangerous patterns
is_dangerous=0
danger_reason=""

if echo "$COMMAND" | grep -qE 'rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r|rm\s+-rf|rm\s+-fr'; then
  is_dangerous=1; danger_reason="rm -rf"
elif echo "$COMMAND" | grep -qE 'git\s+push\s+.*--force|git\s+push\s+.*-f\b'; then
  is_dangerous=1; danger_reason="git push --force"
elif echo "$COMMAND" | grep -qE 'docker\s+rm\b'; then
  is_dangerous=1; danger_reason="docker rm"
elif echo "$COMMAND" | grep -qE 'docker\s+rmi\b'; then
  is_dangerous=1; danger_reason="docker rmi"
elif echo "$COMMAND" | grep -qiE 'DROP\s+TABLE'; then
  is_dangerous=1; danger_reason="DROP TABLE"
elif echo "$COMMAND" | grep -qiE '\btruncate\b'; then
  is_dangerous=1; danger_reason="truncate"
elif echo "$COMMAND" | grep -qE 'mkfs'; then
  is_dangerous=1; danger_reason="mkfs"
elif echo "$COMMAND" | grep -qE ':\(\)\{'; then
  is_dangerous=1; danger_reason="fork bomb"
fi

if [ "$is_dangerous" -eq 0 ]; then
  exit 0
fi

# --- Skip approval if TOOL_APPROVAL=0 (per-session opt-out) ---
if [ "${TOOL_APPROVAL:-1}" = "0" ]; then
  exit 0
fi

# --- No Telegram credentials: block immediately ---
if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ] || [ -z "$THREAD_ID" ]; then
  echo "Dangerous command blocked (no Telegram credentials to request approval): $danger_reason" >&2
  exit 2
fi

# --- Generate unique request ID ---
REQ_ID="$(date +%s%3N)-$$"
RESP_FILE="/tmp/tool-approval-resp-${THREAD_ID}-${REQ_ID}"
PENDING_FILE="/tmp/tool-approval-pending-${THREAD_ID}"

# Write pending file so relay-api knows there's an approval in progress
echo "$REQ_ID" > "$PENDING_FILE"

# --- Send Telegram approval request with buttons ---
DISPLAY_CMD=$(echo "$COMMAND" | head -c 250)

PAYLOAD=$(python3 -c "
import json, sys
chat_id = sys.argv[1]
thread_id = int(sys.argv[2])
reason = sys.argv[3]
cmd = sys.argv[4]
session = sys.argv[5]
req_id = sys.argv[6]
text = '⚠️ <b>אישור נדרש</b> — session <code>' + session + '</code>\n\nסיבה: <code>' + reason + '</code>\nפקודה:\n<pre>' + cmd[:250] + '</pre>'
payload = {
  'chat_id': chat_id,
  'message_thread_id': thread_id,
  'text': text,
  'parse_mode': 'HTML',
  'reply_markup': {
    'inline_keyboard': [[
      {'text': '✅ אשר', 'callback_data': 'btn:' + str(thread_id) + ':approve:' + req_id},
      {'text': '❌ בטל', 'callback_data': 'btn:' + str(thread_id) + ':deny:' + req_id}
    ]]
  }
}
print(json.dumps(payload))
" "$CHAT_ID" "$THREAD_ID" "$danger_reason" "$DISPLAY_CMD" "$SESSION" "$REQ_ID" 2>/dev/null || echo "")

if [ -n "$PAYLOAD" ]; then
  curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD" > /dev/null 2>&1 || true
fi

# --- Poll for approval response (up to 5 minutes) ---
TIMEOUT=300
for i in $(seq 1 "$TIMEOUT"); do
  sleep 1
  if [ -f "$RESP_FILE" ]; then
    RESP=$(cat "$RESP_FILE" 2>/dev/null || echo "denied")
    rm -f "$RESP_FILE" "$PENDING_FILE" 2>/dev/null || true
    if [ "$RESP" = "approved" ]; then
      exit 0
    else
      echo "Command blocked: user denied the operation ($danger_reason)" >&2
      exit 2
    fi
  fi
done

# Timeout — block by default
rm -f "$PENDING_FILE" 2>/dev/null || true
echo "Command blocked: approval timeout after ${TIMEOUT}s ($danger_reason)" >&2
exit 2
