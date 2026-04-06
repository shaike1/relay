#!/bin/bash
# message-watchdog.sh — runs inside each session container.
# Polls for pending Telegram messages and nudges Claude via tmux if Claude is idle.
# Uses per-session tmux socket to avoid cross-container interference.
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:?TELEGRAM_THREAD_ID required}"
SESSION="${SESSION_NAME:?SESSION_NAME required}"
SESSION_TYPE="${SESSION_TYPE:-claude}"
QUEUE="/tmp/tg-queue-${THREAD_ID}.jsonl"
STATE="/tmp/tg-queue-${THREAD_ID}.state"
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"
NUDGE="You have a pending Telegram message. Call fetch_messages and respond."

# Per-session env overrides — survives watchdog restarts without container recreation
# e.g. echo "STREAM_MONITOR=0" > /tmp/relay-session-env-${THREAD_ID}
OVERRIDE_ENV="/tmp/relay-session-env-${THREAD_ID}"
[ -f "$OVERRIDE_ENV" ] && source "$OVERRIDE_ENV" 2>/dev/null || true

INTERVAL=5
IDLE_GRACE=60          # 60 seconds between tmux nudges
MCP_CHECK_INTERVAL=30  # seconds between MCP health checks
TOOL_NOTIFY_COOLDOWN=3 # min seconds between tool-use notifications
CRASH_ALERT_MINUTES=${CRASH_ALERT_MINUTES:-30}  # alert if no response for N minutes
TOOL_MONITOR=${TOOL_MONITOR:-1}  # set to 0 to disable per-session tool notifications

last_nudge=0
last_mcp_check=0
last_tool_hash=""
last_tool_notify=0
last_crash_check=0

# Helper: run tmux with this session's socket
tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }

while true; do
  sleep "$INTERVAL"

  # Session pause — if /tmp/relay-paused-THREAD_ID exists, skip all nudge/wakeup logic
  if [ -f "/tmp/relay-paused-${THREAD_ID}" ]; then
    sleep 10
    continue
  fi

  # Claude launches the MCP server eagerly. Codex can keep MCP wiring dormant
  # until the interactive session actually touches a tool, so skip the hard
  # restart check there and only keep the queue nudge behavior.
  if [ "$SESSION_TYPE" != "codex" ]; then
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
  fi

  # Crash alert — notify if session hasn't sent any message in CRASH_ALERT_MINUTES
  now=$(date +%s)
  if [ $((now - last_crash_check)) -ge 300 ]; then  # check every 5 minutes
    last_crash_check=$now
    last_sent_file="/tmp/tg-last-sent-${THREAD_ID}"
    if [ -f "$last_sent_file" ]; then
      last_sent=$(cat "$last_sent_file" 2>/dev/null | tr -d '[:space:]' || echo "0")
      silence_secs=$((now - ${last_sent%.*}))
      threshold=$((CRASH_ALERT_MINUTES * 60))
      if [ "$silence_secs" -gt "$threshold" ]; then
        mins=$((silence_secs / 60))
        tg-send "⚠️ Session <b>${SESSION}</b> has not sent any message in ${mins} minutes — may be stuck or crashed." 2>/dev/null || true
        # Reset timer so we don't spam — alert again after another CRASH_ALERT_MINUTES
        echo "$now" > "$last_sent_file"
      fi
    fi
  fi

  # Tool monitoring — detect active tool calls and notify Telegram in real time
  if [ "$TOOL_MONITOR" = "1" ] && [ "$SESSION_TYPE" = "claude" ] && tmux_s has-session -t "$SESSION" 2>/dev/null; then
    raw_pane=$(tmux_s capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
    # Strip ANSI escape codes, find the most recent tool call line
    tool_line=$(echo "$raw_pane" | sed 's/\x1b\[[0-9;]*m//g' | \
      grep -oE '[●⬤] (Bash|Read|Edit|Write|Glob|Grep|WebFetch|Agent|TodoWrite|TodoRead|mcp__[A-Za-z_]+)\([^)]{0,120}\)' | \
      tail -1 || echo "")
    if [ -n "$tool_line" ]; then
      tool_hash=$(echo "$tool_line" | cksum | cut -d' ' -f1)
      if [ "$tool_hash" != "$last_tool_hash" ] && [ $((now - last_tool_notify)) -ge "$TOOL_NOTIFY_COOLDOWN" ]; then
        short=$(echo "$tool_line" | cut -c1-100)
        tg-send "<code>${short}</code>" 2>/dev/null &
        last_tool_hash="$tool_hash"
        last_tool_notify=$now
      fi
    fi
  fi

  [ -f "$QUEUE" ] || continue

  last_id=0
  if [ -f "$STATE" ]; then
    last_id=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('lastId',0))" 2>/dev/null || echo 0)
  fi

  pending=$(python3 -c "
import json, time
last_id = $last_id
last_nudge_ts = $last_nudge
count = 0
seen = set()
now = time.time()
with open('$QUEUE') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            mid = msg.get('message_id', 0)
            ts = msg.get('ts', 0)
            # Regular messages: positive ID > lastId
            if mid > 0 and mid > last_id and mid not in seen:
                seen.add(mid)
                count += 1
            # Forced/peer messages: check if arrived after last nudge
            elif mid < 0 and ts > last_nudge_ts and mid not in seen:
                seen.add(mid)
                count += 1
        except Exception:
            pass
print(count)
" 2>/dev/null || echo 0)

  [ "$pending" -gt 0 ] || continue

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

  # Streaming — launch background pane streamer so user sees live progress
  if [ "${STREAM_MONITOR:-0}" = "1" ] && [ "$SESSION_TYPE" = "claude" ]; then
    bash /relay/scripts/stream-pane.sh "$TMUX_SOCKET" "$SESSION" "$THREAD_ID" &
  fi
done
