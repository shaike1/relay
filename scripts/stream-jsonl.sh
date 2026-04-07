#!/bin/bash
# stream-jsonl.sh — streams Claude's output from session JSONL to Telegram.
# Usage: stream-jsonl.sh <WORK_DIR> <THREAD_ID>
set -euo pipefail

WORK_DIR="${1:?work dir required}"
THREAD_ID="${2:?thread id required}"

BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /root/relay/.env | cut -d= -f2 | tr -d '[:space:]')
CHAT_ID=$(grep '^GROUP_CHAT_ID=' /root/relay/.env | cut -d= -f2 | tr -d '[:space:]')

UPDATE_INTERVAL=2
MAX_IDLE_SECS=30

# Find the most recently modified JSONL across all candidate project dirs for this workdir
find_jsonl() {
  local workdir="$1"
  # Generate candidate project keys (Claude Code: path with / → -)
  local key1
  key1=$(echo "$workdir" | sed 's|/|-|g')           # /relay → -relay, /root/relay → -root-relay
  local key2
  key2=$(echo "$workdir" | sed 's|^/||; s|/|-|g')   # /relay → relay (fallback)
  
  local best="" best_mtime=0
  for key in "$key1" "$key2"; do
    local dir="$HOME/.claude/projects/${key}"
    [ -d "$dir" ] || continue
    for f in "$dir"/*.jsonl; do
      [ -f "$f" ] || continue
      local mt
      mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)
      if [ "$mt" -gt "$best_mtime" ]; then
        best_mtime=$mt
        best=$f
      fi
    done
  done
  echo "$best"
}

JSONL=$(find_jsonl "$WORK_DIR")
[ -n "$JSONL" ] || exit 0

tg_post() {
  curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/${1}" \
    -H "Content-Type: application/json" \
    -d "$2" 2>/dev/null || echo "{}"
}

send_msg() {
  tg_post "sendMessage" \
    "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${THREAD_ID},\"text\":\"${1}\",\"parse_mode\":\"HTML\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('message_id',''))" 2>/dev/null
}

edit_msg() {
  local resp
  resp=$(tg_post "editMessageText" \
    "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${THREAD_ID},\"message_id\":${1},\"text\":\"${2}\",\"parse_mode\":\"HTML\"}")
  local retry
  retry=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('parameters',{}).get('retry_after',0))" 2>/dev/null || echo 0)
  [ "${retry:-0}" -gt 0 ] && sleep "$retry" || true
}

delete_msg() {
  tg_post "deleteMessage" \
    "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${THREAD_ID},\"message_id\":${1}}" > /dev/null || true
}

escape_html() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

# Start from current end of file
OFFSET=$(wc -c < "$JSONL" 2>/dev/null || echo 0)

sleep 1

MSG_ID=""
accumulated=""
idle_secs=0

while true; do
  sleep $UPDATE_INTERVAL

  NEW_SIZE=$(wc -c < "$JSONL" 2>/dev/null || echo 0)
  if [ "$NEW_SIZE" -le "$OFFSET" ]; then
    idle_secs=$((idle_secs + UPDATE_INTERVAL))
    [ $idle_secs -ge $MAX_IDLE_SECS ] && break
    continue
  fi

  NEW_TEXT=$(tail -c "+$((OFFSET + 1))" "$JSONL" 2>/dev/null | python3 -c "
import sys, json
out = []
for line in sys.stdin:
    try:
        d = json.loads(line)
        if d.get('type') == 'assistant':
            for c in d.get('message', {}).get('content', []):
                if isinstance(c, dict) and c.get('type') == 'text':
                    t = c['text'].strip()
                    if t:
                        out.append(t)
    except:
        pass
print('\n'.join(out))
" 2>/dev/null || true)

  OFFSET=$NEW_SIZE
  idle_secs=0

  [ -z "$NEW_TEXT" ] && continue

  accumulated="${accumulated}
${NEW_TEXT}"
  DISPLAY=$(printf '%s' "$accumulated" | tail -c 800)
  ESCAPED=$(escape_html "$DISPLAY")

  if [ -z "$MSG_ID" ]; then
    MSG_ID=$(send_msg "⏳ <i>עובד...</i>")
  fi

  [ -n "$MSG_ID" ] && edit_msg "$MSG_ID" "${ESCAPED}" || true
done

if [ -n "$MSG_ID" ]; then
  if [ -n "$accumulated" ]; then
    DISPLAY=$(printf '%s' "$accumulated" | tail -c 800)
    ESCAPED=$(escape_html "$DISPLAY")
    edit_msg "$MSG_ID" "${ESCAPED}" || true
    sleep 8
  fi
  delete_msg "$MSG_ID" || true
fi
