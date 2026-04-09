#!/bin/bash
# tg-echo.sh — Real-time terminal echo for Telegram messages.
# Tails the session queue file and immediately prints incoming user messages
# to the tmux pane so terminal-watchers see Telegram input as it arrives.
#
# Usage: tg-echo.sh THREAD_ID QUEUE_FILE TMUX_SOCKET SESSION_NAME
# Started by message-watchdog.sh as a background singleton.

THREAD_ID="${1:?THREAD_ID required}"
QUEUE="${2:?QUEUE required}"
TMUX_SOCKET="${3:?TMUX_SOCKET required}"
SESSION="${4:?SESSION required}"

# Wait for queue file to exist (up to 30s)
waited=0
while [ ! -f "$QUEUE" ] && [ $waited -lt 30 ]; do
  sleep 1; waited=$((waited+1))
done
[ -f "$QUEUE" ] || exit 0

# Start from current EOF — don't replay existing messages
last_size=$(wc -c < "$QUEUE" 2>/dev/null || echo 0)

tmux_display() {
  local msg="$1"
  # Show in tmux status bar (8s)
  tmux -S "$TMUX_SOCKET" display-message -d 8000 "📨 $msg" 2>/dev/null || true
  # Also inject as a visible comment line into the pane (grey, dimmed)
  # We use a zero-width trick: send the text, then immediately clear it so
  # it appears as a status line but doesn't corrupt Claude's input buffer.
  tmux -S "$TMUX_SOCKET" run-shell \
    "printf '\\r\\033[90m%s\\033[0m\\n' \"$msg\" >/dev/tty 2>/dev/null || true" \
    2>/dev/null || true
}

while true; do
  sleep 1
  [ -f "$QUEUE" ] || continue

  cur_size=$(wc -c < "$QUEUE" 2>/dev/null || echo 0)
  [ "$cur_size" -gt "$last_size" ] || continue

  # Read only the new bytes appended since last check
  new_bytes=$((cur_size - last_size))
  new_content=$(tail -c "$new_bytes" "$QUEUE" 2>/dev/null || true)
  last_size=$cur_size

  # Parse each new JSON line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    msg=$(python3 -c "
import json, sys
try:
    m = json.loads(sys.argv[1])
    mid = m.get('message_id', 0)
    via = m.get('via', '')
    user = m.get('user', '')
    text = (m.get('text', '') or '')[:100].replace(chr(10), ' ')
    # Only echo real user messages — skip system/force/routed entries
    if (mid > 0
            and user not in ('system',)
            and via not in ('auto-route', 'keyword-route', 'skills-route', 'reaction', 'webhook-forward')):
        print(f'{user}: {text}')
except Exception:
    pass
" "$line" 2>/dev/null || true)
    [ -n "$msg" ] || continue
    tmux_display "[Telegram] $msg"
  done <<< "$new_content"
done
