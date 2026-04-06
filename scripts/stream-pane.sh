#!/bin/bash
# stream-pane.sh — streams Claude's tmux pane to Telegram in real-time.
# Launched by message-watchdog when a nudge is sent and Claude is active.
# Sends an initial "working..." message, edits it every 2s with live pane output,
# then deletes it when Claude goes idle (final response already sent via MCP).
#
# Usage: stream-pane.sh <TMUX_SOCKET> <SESSION> <THREAD_ID>
set -euo pipefail

TMUX_SOCKET="${1:?tmux socket required}"
SESSION="${2:?session name required}"
THREAD_ID="${3:?thread id required}"

BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /root/relay/.env | cut -d= -f2 | tr -d '[:space:]')
CHAT_ID=$(grep '^GROUP_CHAT_ID=' /root/relay/.env | cut -d= -f2 | tr -d '[:space:]')

ACTIVE_PATTERNS='✻|Unfurling|⏳|Forging|Misting|Baking|Cogitat|● (Bash|Read|Edit|Write|Glob|Grep|WebFetch|Agent)'
MAX_IDLE=4   # stop after this many consecutive idle checks (×2s = 8s idle)
UPDATE_INTERVAL=2

tg_post() {
  local endpoint="$1"
  local body="$2"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}" \
    -H "Content-Type: application/json" \
    -d "$body"
}

send_initial() {
  tg_post "sendMessage" \
    "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${THREAD_ID},\"text\":\"⏳ <i>עובד...</i>\",\"parse_mode\":\"HTML\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('message_id',''))" 2>/dev/null
}

edit_msg() {
  local msg_id="$1"
  local text="$2"
  tg_post "editMessageText" \
    "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${THREAD_ID},\"message_id\":${msg_id},\"text\":\"${text}\",\"parse_mode\":\"HTML\"}" \
    > /dev/null 2>&1 || true
}

delete_msg() {
  local msg_id="$1"
  tg_post "deleteMessage" \
    "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${THREAD_ID},\"message_id\":${msg_id}}" \
    > /dev/null 2>&1 || true
}

get_clean_pane() {
  tmux -S "$TMUX_SOCKET" capture-pane -t "$SESSION" -p 2>/dev/null \
    | sed 's/\x1b\[[0-9;]*[mGKHFABCDJP]//g' \
    | grep -v '^[[:space:]]*$' \
    | grep -v '^[─═│╭╮╰╯┤├┬┴┼]' \
    | grep -v '^\s*[⎿⏎]' \
    | grep -v '^\s*>' \
    | tail -8 \
    | head -c 600 \
    | tr -d '\r' \
    | sed 's/\\n/\n/g' \
    | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/\\/\&#92;/g'
}

is_active() {
  tmux -S "$TMUX_SOCKET" capture-pane -t "$SESSION" -p 2>/dev/null \
    | grep -qE "$ACTIVE_PATTERNS"
}

# Wait briefly for Claude to actually start processing
sleep 1

# Send initial message
MSG_ID=$(send_initial)
[ -z "$MSG_ID" ] && exit 0

idle_count=0
last_text=""

while true; do
  sleep $UPDATE_INTERVAL

  # Stop if tmux session gone
  tmux -S "$TMUX_SOCKET" has-session -t "$SESSION" 2>/dev/null || break

  if is_active; then
    idle_count=0
    pane_text=$(get_clean_pane || echo "")
    if [ -n "$pane_text" ] && [ "$pane_text" != "$last_text" ]; then
      edit_msg "$MSG_ID" "<pre>${pane_text}</pre>"
      last_text="$pane_text"
    fi
  else
    idle_count=$((idle_count + 1))
    [ $idle_count -ge $MAX_IDLE ] && break
  fi
done

# Claude finished — delete the streaming placeholder (final response already in chat)
delete_msg "$MSG_ID"
