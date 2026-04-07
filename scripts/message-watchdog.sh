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
IDLE_GRACE=30          # seconds between nudge retries (fallback if MCP notification missed)
RELAY_API_URL="${RELAY_API_URL:-}"  # if set, pull queue from remote relay-api (for remote sessions)
RELAY_API_TOKEN="${RELAY_API_TOKEN:-}"
MCP_CHECK_INTERVAL=30  # seconds between MCP health checks
TOOL_NOTIFY_COOLDOWN=3 # min seconds between tool-use notifications
CRASH_ALERT_MINUTES=${CRASH_ALERT_MINUTES:-30}  # alert if no response for N minutes
TOOL_MONITOR=${TOOL_MONITOR:-1}  # set to 0 to disable per-session tool notifications
STREAM_MONITOR=${STREAM_MONITOR:-1}  # live pane streaming when new message arrives

last_nudge=0
last_nudged_id=0   # track highest message_id nudged — only nudge new messages once
last_mcp_check=0
last_tool_hash=""
last_tool_notify=0
last_crash_check=0
last_stream_trigger=0   # last time streaming was started
last_queue_mtime=0      # track queue file mtime to detect new messages

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
      alerted_file="/tmp/tg-crash-alerted-${THREAD_ID}"
      if [ "$silence_secs" -gt "$threshold" ] && [ ! -f "$alerted_file" ]; then
        mins=$((silence_secs / 60))
        ALERT_TEXT="⚠️ Session <b>${SESSION}</b> has not sent any message in ${mins} minutes — may be stuck or crashed."
        tg-send "$ALERT_TEXT" 2>/dev/null || true
        # Also send a direct DM notification if NOTIFY_USER_ID is set
        RELAY_API_URL="${RELAY_API_URL:-http://relay-api:9100}"
        curl -sf -X POST "${RELAY_API_URL}/api/notify" \
          -H "Content-Type: application/json" \
          -d "{\"text\":\"$ALERT_TEXT\",\"urgent\":true}" \
          2>/dev/null || true
        # Set alerted flag — don't repeat until Claude sends a real message (flag cleared by mcp-telegram on send)
        touch "$alerted_file"
      fi
    fi
  fi

  # Rate-limit detection — check pane for API rate limit / overload errors every 30s
  now=$(date +%s)
  if [ "${last_ratelimit_check:-0}" -eq 0 ] || [ $((now - last_ratelimit_check)) -ge 30 ]; then
    last_ratelimit_check=$now
    rl_pane=$(tmux_s capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
    rl_flag="/tmp/tg-ratelimit-alerted-${THREAD_ID}"
    if echo "$rl_pane" | grep -qiE "rate.?limit|overloaded|529|too many requests|usage limit|slowdown|capacity"; then
      if [ ! -f "$rl_flag" ]; then
        touch "$rl_flag"
        tg-send "⏳ Session <b>${SESSION}</b> hit a rate limit / API overload — paused until it clears automatically." 2>/dev/null || true
      fi
    else
      # Clear flag once pane no longer shows rate limit
      rm -f "$rl_flag" 2>/dev/null || true
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

  # Remote session pull: fetch new messages from relay-api and append to local queue
  if [ -n "$RELAY_API_URL" ]; then
    local_last_id=0
    [ -f "$STATE" ] && local_last_id=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('lastId',0))" 2>/dev/null || echo 0)
    auth_header=""
    [ -n "$RELAY_API_TOKEN" ] && auth_header="-H \"Authorization: Bearer $RELAY_API_TOKEN\""
    new_entries=$(curl -sf --connect-timeout 5 $auth_header \
      "${RELAY_API_URL}/api/queue/${THREAD_ID}/messages?since=${local_last_id}" 2>/dev/null || echo "[]")
    if [ "$new_entries" != "[]" ] && [ -n "$new_entries" ]; then
      echo "$new_entries" | python3 -c "
import json, sys
entries = json.load(sys.stdin)
if isinstance(entries, list):
    with open('$QUEUE', 'a') as f:
        for e in entries:
            f.write(json.dumps(e) + '\n')
    print(len(entries))
" 2>/dev/null | read count && [ "${count:-0}" -gt 0 ] && echo "[watchdog] pulled $count new messages from relay-api" >&2 || true
    fi
  fi

  [ -f "$QUEUE" ] || continue

  last_id=0
  if [ -f "$STATE" ]; then
    last_id=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('lastId',0))" 2>/dev/null || echo 0)
  fi

  pending_info=$(python3 -c "
import json, time
last_id = $last_id
last_nudge_ts = $last_nudge
count = 0
max_id = 0
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
                if mid > max_id: max_id = mid
            # Forced/peer messages: check if arrived after last nudge
            elif mid < 0 and ts > last_nudge_ts and mid not in seen:
                seen.add(mid)
                count += 1
        except Exception:
            pass
print(count, max_id)
" 2>/dev/null || echo "0 0")
  pending=$(echo "$pending_info" | awk '{print $1}')
  highest_pending_id=$(echo "$pending_info" | awk '{print $2}')

  # Streaming — trigger on queue file change regardless of pending count.
  # MCP delivers instantly so pending=0 by the time watchdog checks, but we still
  # want to stream Claude's response as it's being generated.
  if [ "${STREAM_MONITOR:-0}" = "1" ] && [ "$SESSION_TYPE" = "claude" ] && [ -f "$QUEUE" ]; then
    cur_mtime=$(stat -c %Y "$QUEUE" 2>/dev/null || echo 0)
    now=$(date +%s)
    stream_running=$(pgrep -f "stream-jsonl.sh.*${THREAD_ID}" > /dev/null 2>&1 && echo 1 || echo 0)
    if [ "$cur_mtime" -gt "$last_queue_mtime" ] && [ $((now - last_stream_trigger)) -ge 30 ] && [ "$stream_running" = "0" ]; then
      last_queue_mtime=$cur_mtime
      last_stream_trigger=$now
      bash /relay/scripts/stream-jsonl.sh "${WORKDIR:-/relay}" "$THREAD_ID" &
    fi
  fi

  [ "$pending" -gt 0 ] || continue

  # Check if tmux session is alive in this container's socket
  tmux_s has-session -t "$SESSION" 2>/dev/null || continue

  # Nudge via tmux — only when IDLE_GRACE > 0
  [ "$IDLE_GRACE" -gt 0 ] || continue

  now=$(date +%s)
  # Only nudge for new messages (id > last_nudged_id)
  # Never retry the same message_id — prevents spam
  [ "$highest_pending_id" -gt "$last_nudged_id" ] || continue

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
  [ "$highest_pending_id" -gt "$last_nudged_id" ] && last_nudged_id=$highest_pending_id
done
