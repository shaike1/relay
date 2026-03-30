#!/bin/bash
# message-watchdog.sh — runs inside each session container.
# Polls for pending Telegram messages and nudges Claude via tmux if Claude is idle.
# Uses per-session tmux socket to avoid cross-container interference.
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:?TELEGRAM_THREAD_ID required}"
SESSION="${SESSION_NAME:?SESSION_NAME required}"
QUEUE="/tmp/tg-queue-${THREAD_ID}.jsonl"
STATE="/tmp/tg-queue-${THREAD_ID}.state"
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"
NUDGE="You have a pending Telegram message. Call fetch_messages and respond."

INTERVAL=5
IDLE_GRACE=300         # 5 minutes between tmux nudges (MCP sessions get direct delivery)
MCP_CHECK_INTERVAL=30  # seconds between MCP health checks

last_nudge=0
last_mcp_check=0

# Helper: run tmux with this session's socket
tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }

while true; do
  sleep "$INTERVAL"

  # MCP health check: if Claude is running but bun (MCP server) is not, restart the container
  now=$(date +%s)
  if [ $((now - last_mcp_check)) -ge "$MCP_CHECK_INTERVAL" ]; then
    last_mcp_check=$now
    claude_running=$(pgrep -f 'claude' > /dev/null 2>&1 && echo 1 || echo 0)
    mcp_running=$(pgrep -f 'bun.*mcp-telegram' > /dev/null 2>&1 && echo 1 || echo 0)
    if [ "$claude_running" = "1" ] && [ "$mcp_running" = "0" ]; then
      echo "[watchdog:${SESSION}] MCP server missing — restarting container to reload .mcp.json" >&2
      # Kill claude so s6 restarts the whole session (which reloads .mcp.json)
      pkill -f 'claude' 2>/dev/null || true
    fi
  fi

  [ -f "$QUEUE" ] || continue

  last_id=0
  if [ -f "$STATE" ]; then
    last_id=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('lastId',0))" 2>/dev/null || echo 0)
  fi

  pending=$(python3 -c "
import json
last_id = $last_id
count = 0
seen = set()
with open('$QUEUE') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            mid = msg.get('message_id', 0)
            if mid > last_id and mid not in seen:
                seen.add(mid)
                count += 1
        except Exception:
            pass
print(count)
" 2>/dev/null || echo 0)

  [ "$pending" -gt 0 ] || continue

  # If MCP server is running, it handles message delivery — skip tmux nudge
  # (MCP delivers via notifications/claude/channel; tmux nudges are only for non-MCP sessions)
  if pgrep -f 'bun.*mcp-telegram' > /dev/null 2>&1; then
    continue
  fi

  # Check if tmux session is alive in this container's socket
  tmux_s has-session -t "$SESSION" 2>/dev/null || continue

  now=$(date +%s)
  elapsed=$((now - last_nudge))
  [ "$elapsed" -ge "$IDLE_GRACE" ] || continue

  # Skip if Claude is actively working — check last 3 non-empty lines for active indicators
  pane=$(tmux_s capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
  last_lines=$(echo "$pane" | grep -v "^[[:space:]]*$" | tail -3)
  if echo "$last_lines" | grep -qE "✻|Unfurling|⏳|Forging|Misting|Baking|Cogitat"; then
    continue
  fi

  # Send text first, then Enter after a brief pause so Claude's TUI registers both
  tmux_s send-keys -t "$SESSION" "$NUDGE"
  sleep 0.3
  tmux_s send-keys -t "$SESSION" "" Enter
  last_nudge=$now
done
