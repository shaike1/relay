#!/bin/bash
# stream-pane.sh — streams Claude's tmux pane to Telegram in real-time.
# Sends an initial "working..." message, edits it every 2s with live pane output,
# stops when pane hasn't changed for MAX_IDLE_SECS and Claude is at idle prompt.
#
# Usage: stream-pane.sh <TMUX_SOCKET> <SESSION> <THREAD_ID>
set -euo pipefail

TMUX_SOCKET="${1:?tmux socket required}"
SESSION="${2:?session name required}"
THREAD_ID="${3:?thread id required}"

BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /root/relay/.env | cut -d= -f2 | tr -d '[:space:]')
CHAT_ID=$(grep '^GROUP_CHAT_ID=' /root/relay/.env | cut -d= -f2 | tr -d '[:space:]')

MAX_IDLE_SECS=20   # stop after 20s of no pane changes at idle prompt
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
  local resp
  resp=$(tg_post "editMessageText" \
    "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${THREAD_ID},\"message_id\":${msg_id},\"text\":\"${text}\",\"parse_mode\":\"HTML\"}" 2>/dev/null || echo "")
  # Respect rate limit
  local retry
  retry=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('parameters',{}).get('retry_after',0))" 2>/dev/null || echo "0")
  if [ "${retry:-0}" -gt 0 ]; then
    sleep "$retry"
  fi
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
    | grep -v '^\s*[⎿⏎✢]' \
    | grep -v '^\s*>' \
    | grep -v '^\s*❯' \
    | grep -v '^\s*[●⬤]' \
    | grep -v 'bypass permissions' \
    | grep -v 'shift+tab to cycle' \
    | grep -vE 'root@[a-f0-9]+:' \
    | grep -vE 'ctx:[[:space:]]*[0-9]+%' \
    | grep -v 'Sonnet\|Opus\|Haiku' \
    | grep -v '(@@).*Crumpet' \
    | grep -v '^[[:space:]]*(@)' \
    | grep -v '^[[:space:]]*\.\.\.' \
    | tail -10 \
    | head -c 800 \
    | tr -d '\r' \
    | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/\\/\&#92;/g'
}

is_at_idle_prompt() {
  # True when Claude is at the ❯ prompt and not showing spinner/tool patterns
  local pane
  pane=$(tmux -S "$TMUX_SOCKET" capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
  echo "$pane" | grep -qE '^\s*❯\s*$' && \
  ! echo "$pane" | grep -qE '✻|Unfurling|⏳|Forging|Misting|Baking|Cogitat|Drizzl|● (Bash|Read|Edit|Write|Glob|Grep|WebFetch|Agent)'
}

# Wait briefly for Claude to start processing
sleep 2

# Send initial message
MSG_ID=$(send_initial)
[ -z "$MSG_ID" ] && exit 0

idle_secs=0
last_text=""

while true; do
  sleep $UPDATE_INTERVAL

  # Stop if tmux session gone
  tmux -S "$TMUX_SOCKET" has-session -t "$SESSION" 2>/dev/null || break

  pane_text=$(get_clean_pane || echo "")

  if [ "$pane_text" != "$last_text" ] && [ -n "$pane_text" ]; then
    # Pane changed — update message and reset idle timer
    edit_msg "$MSG_ID" "<pre>${pane_text}</pre>"
    last_text="$pane_text"
    idle_secs=0
  else
    idle_secs=$((idle_secs + UPDATE_INTERVAL))
    # Stop after MAX_IDLE_SECS of no changes when at idle prompt
    if [ $idle_secs -ge $MAX_IDLE_SECS ] && is_at_idle_prompt; then
      break
    fi
  fi
done

# Claude finished — delete the streaming placeholder (final response already in chat)
delete_msg "$MSG_ID"
