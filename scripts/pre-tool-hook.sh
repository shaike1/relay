#!/bin/bash
# pre-tool-hook.sh — PreToolUse hook: blocks dangerous operations and logs all tool use.
# Reads JSON from stdin (Claude Code PreToolUse hook format).
# Exits 2 to block, 0 to allow.
set -euo pipefail

# Load credentials from .env
BOT_TOKEN=""
CHAT_ID=""
if [ -f /root/relay/.env ]; then
  BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1)
  CHAT_ID=$(grep -E '^GROUP_CHAT_ID=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1)
fi

THREAD_ID="${TELEGRAM_THREAD_ID:-}"

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

# --- Dangerous: send Telegram confirmation request ---
if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ] && [ -n "$THREAD_ID" ]; then
  # Truncate command for display
  DISPLAY_CMD=$(echo "$COMMAND" | head -c 200)

  PAYLOAD=$(python3 -c "
import json, sys
chat_id = sys.argv[1]
thread_id = int(sys.argv[2])
reason = sys.argv[3]
cmd = sys.argv[4]
text = '⚠️ <b>פעולה מסוכנת זוהתה</b>\n\nסיבה: <code>' + reason + '</code>\nפקודה:\n<pre>' + cmd[:200] + '</pre>\n\nלאשר את הפעולה?'
payload = {
  'chat_id': chat_id,
  'message_thread_id': thread_id,
  'text': text,
  'parse_mode': 'HTML',
  'reply_markup': {
    'inline_keyboard': [[
      {'text': 'אשר', 'callback_data': 'confirm_tool'},
      {'text': 'בטל', 'callback_data': 'cancel_tool'}
    ]]
  }
}
print(json.dumps(payload))
" "$CHAT_ID" "$THREAD_ID" "$danger_reason" "$DISPLAY_CMD" 2>/dev/null)

  if [ -n "$PAYLOAD" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "$PAYLOAD" > /dev/null 2>&1 || true
  fi

  # Write flag file
  touch "/tmp/relay-pending-confirm-${THREAD_ID}" 2>/dev/null || true
fi

# Exit 2 to block the tool call
exit 2
