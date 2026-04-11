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

INTERVAL=5
IDLE_GRACE=0           # 0 = disabled — rely on MCP notifications only (no token waste)
RELAY_API_URL=""       # if set, pull queue from remote relay-api (for remote sessions)
RELAY_API_TOKEN=""
MCP_CHECK_INTERVAL=3   # seconds between MCP health checks (fast detection, watchdog loop is cheap)
TOOL_NOTIFY_COOLDOWN=3 # min seconds between tool-use notifications
CRASH_ALERT_MINUTES=${CRASH_ALERT_MINUTES:-30}  # alert if no response for N minutes
TOOL_MONITOR=1         # set to 0 to disable per-session tool notifications
STREAM_MONITOR=1       # live pane streaming when new message arrives
SCHEDULE_CHECK_INTERVAL=60  # seconds between schedule checks
TOKEN_ALERT_THRESHOLD=${TOKEN_ALERT_THRESHOLD:-10000}  # output tokens/5min before alert (0=disabled)
LOOP_DETECT_ENABLED=${LOOP_DETECT_ENABLED:-1}          # detect stuck loops
LOOP_DETECT_WINDOW=5   # consecutive identical tool hashes before alert

# Per-session env overrides — sourced AFTER defaults so they take effect
# e.g. echo "RELAY_API_URL=https://relay.right-api.com" > /tmp/relay-session-env-${THREAD_ID}
OVERRIDE_ENV="/tmp/relay-session-env-${THREAD_ID}"
[ -f "$OVERRIDE_ENV" ] && source "$OVERRIDE_ENV" 2>/dev/null || true

last_nudge=0
last_nudged_id=0   # track highest message_id nudged — only nudge new messages once
last_mcp_check=0
mcp_restart_count=0     # consecutive MCP restart attempts (for backoff)
last_mcp_restart=0      # timestamp of last MCP restart
last_tool_hash=""
last_tool_notify=0
last_crash_check=0
last_stream_trigger=0   # last time streaming was started
last_queue_mtime=0      # track queue file mtime to detect new messages
last_schedule_check=0   # last time schedule entries were checked
last_health_check=0     # last time health/token alert check ran
loop_hash_count=0       # count of consecutive identical tool call hashes
last_loop_hash=""       # last seen tool hash for loop detection
last_loop_alert=0       # timestamp of last loop alert (5min cooldown)

# Helper: run tmux with this session's socket
tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }

# ── Real-time terminal echo ──────────────────────────────────────────────────
# Starts tg-echo.sh in background — tails queue and prints incoming Telegram
# messages to the tmux pane immediately, without waiting for nudge delay.
RT_ECHO_SCRIPT="/relay/scripts/tg-echo.sh"
RT_ECHO_PID_FILE="/tmp/tg-echo-${THREAD_ID}.pid"
if [ -f "$RT_ECHO_SCRIPT" ]; then
  # Only start if not already running
  if [ -f "$RT_ECHO_PID_FILE" ]; then
    _echo_pid=$(cat "$RT_ECHO_PID_FILE" 2>/dev/null)
    if ! kill -0 "$_echo_pid" 2>/dev/null; then
      rm -f "$RT_ECHO_PID_FILE"
    fi
  fi
  if [ ! -f "$RT_ECHO_PID_FILE" ]; then
    bash "$RT_ECHO_SCRIPT" "$THREAD_ID" "$QUEUE" "$TMUX_SOCKET" "$SESSION" &
    echo $! > "$RT_ECHO_PID_FILE"
  fi
fi

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
      claude_running=$(pgrep -x 'claude' > /dev/null 2>&1 && echo 1 || echo 0)
      mcp_running=$(pgrep -f 'bun.*mcp-telegram' > /dev/null 2>&1 && echo 1 || echo 0)
      if [ "$claude_running" = "1" ] && [ "$mcp_running" = "0" ]; then
        # Backoff: 0s, 5s, 10s, 20s, 40s (cap at 60s) between consecutive restarts
        _backoff=0
        if [ "$mcp_restart_count" -gt 0 ]; then
          _backoff=$(( mcp_restart_count * 10 ))
          [ "$_backoff" -gt 60 ] && _backoff=60
        fi
        _now=$(date +%s)
        _since_last=$(( _now - last_mcp_restart ))
        if [ "$_since_last" -ge "$_backoff" ]; then
          echo "[watchdog:${SESSION}] MCP server missing (restart #$((mcp_restart_count+1))) — restarting" >&2
          mcp_restart_count=$((mcp_restart_count + 1))
          last_mcp_restart=$_now
          pkill -f 'claude' 2>/dev/null || true
        else
          echo "[watchdog:${SESSION}] MCP missing but in backoff (${_since_last}s < ${_backoff}s)" >&2
        fi
      else
        # MCP is running — reset restart counter
        mcp_restart_count=0
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
      # Only alert if there are actually pending messages — idle silence is fine
      _queue_pending=0
      if [ -f "$QUEUE" ]; then
        _queue_pending=$(python3 -c "
import json
last_id = $([ -f '$STATE' ] && python3 -c "import json; d=json.load(open('$STATE')); print(d.get('lastId',0))" 2>/dev/null || echo 0)
count = 0
with open('$QUEUE') as f:
    for line in f:
        try:
            m = json.loads(line)
            if m.get('message_id', 0) > last_id: count += 1
        except: pass
print(count)
" 2>/dev/null || echo 0)
      fi
      if [ "$silence_secs" -gt "$threshold" ] && [ ! -f "$alerted_file" ] && [ "$_queue_pending" -gt 0 ]; then
        mins=$((silence_secs / 60))
        ALERT_TEXT="⚠️ Session ${SESSION} has not responded in ${mins} minutes — check if stuck."
        # Inject as a system force message directly into the queue (no tg-send to Telegram topic —
        # sending via bot caused the alert text to get merged into the next user message via webhook).
        # Also include the oldest pending message preview (item 5: response SLA alert).
        python3 -c "
import json, time, sys
queue_file = sys.argv[1]
alert_text = sys.argv[2]
state_file = sys.argv[3]

# Load lastId to find pending messages
last_id = 0
try:
    d = json.load(open(state_file))
    last_id = d.get('lastId', 0)
except Exception:
    pass

# Find oldest pending user message for SLA context
try:
    pending = []
    with open(queue_file) as f:
        for line in f:
            try:
                m = json.loads(line)
                mid = m.get('message_id', 0)
                if mid > 0 and mid > last_id:
                    pending.append(m)
            except Exception:
                pass
    if pending:
        oldest = pending[0]
        user = oldest.get('user', 'user')
        text = (oldest.get('text', '') or '')[:60].replace('\n', ' ')
        alert_text += f' Waiting: [{user}] \"{text}\"'
except Exception:
    pass

ts = int(time.time())
entry = {
    'message_id': -ts,
    'user': 'system',
    'text': alert_text,
    'ts': ts,
    'via': 'watchdog',
    'force': True
}
with open(queue_file, 'a') as f:
    f.write(json.dumps(entry) + '\n')
" "$QUEUE" "$ALERT_TEXT" "${STATE:-/dev/null}" 2>/dev/null || true
        # Set alerted flag — don't repeat until Claude sends a real message (flag cleared by mcp-telegram on send)
        touch "$alerted_file"

        # Persistent delivery DM — notify NOTIFY_USER_ID directly if configured
        _notify_user_id=""
        _bot_token=""
        if [ -f /root/relay/.env ]; then
          _notify_user_id=$(grep -E '^NOTIFY_USER_ID=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1 || true)
          _bot_token=$(grep -E '^TELEGRAM_BOT_TOKEN=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1 || true)
        fi
        if [ -n "$_notify_user_id" ] && [ -n "$_bot_token" ]; then
          _dm_text="📵 <b>${SESSION}</b> has not responded for ${mins} min — possible stuck or crashed."
          curl -sf -X POST "https://api.telegram.org/bot${_bot_token}/sendMessage" \
            -H 'Content-Type: application/json' \
            -d "{\"chat_id\":\"${_notify_user_id}\",\"text\":\"${_dm_text}\",\"parse_mode\":\"HTML\"}" \
            > /dev/null 2>&1 || true
        fi
      fi
    fi
  fi

  # Proactive schedule — inject queue messages for time-based entries in sessions.json
  # Format: "schedule": [{"time": "HH:MM", "days": "1-5", "message": "..."}]
  # days: "1-7" (Mon=1, Sun=7), or "1-5" for weekdays, omit for every day
  now=$(date +%s)
  if [ $((now - last_schedule_check)) -ge "$SCHEDULE_CHECK_INTERVAL" ]; then
    last_schedule_check=$now
    current_hhmm=$(date +"%H:%M")
    current_dow=$(date +"%u")  # 1=Mon, 7=Sun
    python3 - "$THREAD_ID" "$QUEUE" "$current_hhmm" "$current_dow" <<'SCHEDULE_PY' 2>/dev/null || true
import json, sys, os, time

thread_id = sys.argv[1]
queue_file = sys.argv[2]
current_hhmm = sys.argv[3]
current_dow = int(sys.argv[4])

# Load sessions.json and find our session
try:
    sessions = json.load(open('/root/relay/sessions.json'))
    session = next((s for s in sessions if str(s.get('thread_id','')) == thread_id), None)
    if not session or 'schedule' not in session:
        sys.exit(0)
    schedule = session['schedule']
except Exception:
    sys.exit(0)

# Fired-today tracking file to avoid double-firing
fired_file = f'/tmp/relay-schedule-fired-{thread_id}-{time.strftime("%Y%m%d")}'
fired = set()
try:
    fired = set(open(fired_file).read().split())
except Exception:
    pass

for entry in schedule:
    t = entry.get('time', '')
    msg = entry.get('message', '')
    days = entry.get('days', '1-7')
    if not t or not msg:
        continue
    # Check time match (exact HH:MM)
    if t != current_hhmm:
        continue
    # Check day-of-week range (e.g. "1-5" = Mon-Fri)
    if '-' in str(days):
        parts = str(days).split('-')
        day_start, day_end = int(parts[0]), int(parts[1])
        if not (day_start <= current_dow <= day_end):
            continue
    # Deduplicate: don't fire same entry twice in same day
    entry_key = f'{t}:{msg[:20]}'
    if entry_key in fired:
        continue
    # Inject scheduled message into queue
    entry_msg = {
        'text': f'[Scheduled {t}] {msg}',
        'user': 'system:schedule',
        'message_id': -int(time.time() * 1000),
        'ts': time.time(),
        'force': True
    }
    with open(queue_file, 'a') as f:
        f.write(json.dumps(entry_msg) + '\n')
    fired.add(entry_key)
    print(f'[schedule] fired: {entry_key}', file=sys.stderr)

# Write fired set back
try:
    with open(fired_file, 'w') as f:
        f.write('\n'.join(fired))
except Exception:
    pass
SCHEDULE_PY
  fi

  # Health monitoring — token rate alerts + loop detection (every 60s)
  now=$(date +%s)
  if [ $((now - last_health_check)) -ge 60 ]; then
    last_health_check=$now

    # --- Token rate alert ---
    if [ "${TOKEN_ALERT_THRESHOLD:-0}" -gt 0 ]; then
      python3 - "$THREAD_ID" "$SESSION" "$TOKEN_ALERT_THRESHOLD" <<'HEALTH_PY' 2>/dev/null || true
import json, sys, os, time

thread_id, session, threshold = sys.argv[1], sys.argv[2], int(sys.argv[3])
stats_file = f"/tmp/token-stats-{thread_id}.jsonl"
alert_cooldown_file = f"/tmp/relay-token-alert-cooldown-{thread_id}"

if not os.path.exists(stats_file):
    sys.exit(0)

# Cooldown: only alert once per 10 minutes
try:
    last_alert = float(open(alert_cooldown_file).read().strip())
    if time.time() - last_alert < 600:
        sys.exit(0)
except Exception:
    pass

cutoff = time.time() - 300  # last 5 min
total_out = 0
try:
    for line in open(stats_file).readlines()[-50:]:
        try:
            e = json.loads(line.strip())
            ts_str = e.get("ts", "")
            if ts_str:
                import datetime
                ts = datetime.datetime.fromisoformat(ts_str).timestamp()
                if ts > cutoff:
                    total_out += e.get("output", 0)
        except Exception:
            pass
except Exception:
    sys.exit(0)

if total_out > threshold:
    # Send Telegram alert
    bot_token = ""
    chat_id = ""
    try:
        for line in open("/root/relay/.env"):
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                bot_token = line.strip().split("=", 1)[1].strip('"\'')
            elif line.startswith("GROUP_CHAT_ID="):
                chat_id = line.strip().split("=", 1)[1].strip('"\'')
    except Exception:
        pass

    if bot_token and chat_id:
        import urllib.request
        msg = f"⚡ <b>Token spike: {session}</b>\n{total_out:,} output tokens in last 5 min (threshold: {threshold:,})\nCheck if session is stuck in a loop."
        import urllib.parse
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id": chat_id,
            "message_thread_id": thread_id,
            "text": msg,
            "parse_mode": "HTML"
        }).encode()
        try:
            urllib.request.urlopen(url, data, timeout=8)
            open(alert_cooldown_file, "w").write(str(time.time()))
        except Exception:
            pass
HEALTH_PY
    fi

    # --- Loop detection ---
    if [ "${LOOP_DETECT_ENABLED:-1}" = "1" ]; then
      # Exclude MCP telegram tools (typing, send_message, fetch_messages) — these repeat normally
      _tool_lines=$(tmux_s capture-pane -pt "${SESSION}:0" -l 20 2>/dev/null \
        | grep -E '●|Tool:|Bash\(|Edit\(|Read\(' | grep -v 'telegram\|ToolSearch\|MCP' | tail -3)
      # Skip if no tool lines remain after filtering (avoids empty hash false positives)
      if [ -z "$_tool_lines" ]; then
        loop_hash_count=0
        last_loop_hash=""
      else
        current_tool_hash=$(echo "$_tool_lines" | md5sum | cut -c1-8)
        if [ "$current_tool_hash" = "$last_loop_hash" ]; then
          loop_hash_count=$((loop_hash_count + 1))
          if [ "$loop_hash_count" -ge "$LOOP_DETECT_WINDOW" ]; then
            # Alert and reset counter (with 5min cooldown)
            loop_hash_count=0
            _now=$(date +%s)
            if [ $((_now - last_loop_alert)) -lt 300 ]; then
              continue  # skip alert — cooldown active
            fi
            last_loop_alert=$_now
            BOT_TOKEN=""
            CHAT_ID=""
            [ -f /root/relay/.env ] && {
              BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1)
              CHAT_ID=$(grep -E '^GROUP_CHAT_ID=' /root/relay/.env | cut -d= -f2- | tr -d '"'"'" | head -1)
            }
            if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
              MSG="🔄 <b>Loop detected: ${SESSION}</b>
Repeating the same tool calls for 5+ cycles. Session may be stuck."
              curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
                -d "chat_id=${CHAT_ID}&message_thread_id=${THREAD_ID}&text=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$MSG")&parse_mode=HTML" \
                > /dev/null 2>&1 || true
            fi
          fi
        else
          loop_hash_count=0
          last_loop_hash="$current_tool_hash"
        fi
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
    _pull_last_id=0
    [ -f "$STATE" ] && _pull_last_id=$(python3 -c "import json; d=json.load(open('$STATE')); print(d.get('lastId',0))" 2>/dev/null || echo 0)
    _pull_url="${RELAY_API_URL}/api/queue/${THREAD_ID}/messages?since=${_pull_last_id}"
    _pull_tmp="/tmp/relay-pull-${THREAD_ID}.json"
    curl -sf --connect-timeout 5 "$_pull_url" > "$_pull_tmp" 2>/dev/null || true
    if [ -s "$_pull_tmp" ]; then
      python3 - "$_pull_tmp" "$QUEUE" <<'PYEOF' 2>/dev/null
import json, sys
data = json.load(open(sys.argv[1]))
if isinstance(data, list) and data:
    with open(sys.argv[2], 'a') as f:
        for e in data:
            f.write(json.dumps(e) + '\n')
    print(len(data))
PYEOF
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

  # tmux send-keys fallback — fires ONCE per new message after TMUX_FALLBACK_DELAY seconds
  # This is the ccbot-style delivery: reliable even when MCP notification misses.
  # IDLE_GRACE=0 disables it; TMUX_FALLBACK_DELAY (default 60s) controls the delay.
  TMUX_FALLBACK_DELAY=${TMUX_FALLBACK_DELAY:-60}
  [ "$TMUX_FALLBACK_DELAY" -gt 0 ] || continue

  now=$(date +%s)
  # Only fire for new message_id — never repeat the same message
  [ "$highest_pending_id" -gt "$last_nudged_id" ] || continue

  # Wait TMUX_FALLBACK_DELAY seconds before firing — gives MCP notification time to deliver
  msg_arrived_ts=$(python3 -c "
import json
with open('$QUEUE') as f:
    for line in f:
        try:
            m = json.loads(line)
            if m.get('message_id') == $highest_pending_id:
                print(int(m.get('ts', 0)))
                break
        except: pass
print(0)
" 2>/dev/null | head -1)
  [ "${msg_arrived_ts:-0}" -gt 0 ] || msg_arrived_ts=$now
  msg_age=$((now - msg_arrived_ts))
  [ "$msg_age" -ge "$TMUX_FALLBACK_DELAY" ] || continue

  # Check if Claude is actively working
  pane=$(tmux_s capture-pane -t "$SESSION" -p 2>/dev/null || echo "")
  last_lines=$(echo "$pane" | grep -v "^[[:space:]]*$" | tail -3)
  if echo "$last_lines" | grep -qE "✻|Unfurling|⏳|Forging|Misting|Baking|Cogitat"; then
    # Busy — check if message has been waiting too long (>3 min) and force-nudge anyway
    msg_wait=$((now - msg_arrived_ts))
    [ "$msg_wait" -lt 180 ] && continue
  fi

  # Build nudge text: include message preview for terminal echo (item 1)
  NUDGE_PREVIEW=$(python3 -c "
import json
last_id = $last_id
queue_lines = []
try:
    with open('$QUEUE') as f:
        queue_lines = f.readlines()
except Exception:
    pass
for line in reversed(queue_lines):
    try:
        m = json.loads(line)
        mid = m.get('message_id', 0)
        if mid == $highest_pending_id:
            user = m.get('user', 'user')
            text = (m.get('text', '') or '')[:80].replace(chr(10), ' ')
            print(f'{user}: {text}')
            break
    except Exception:
        pass
" 2>/dev/null || echo "")

  NUDGE_TEXT="$NUDGE"
  if [ -n "$NUDGE_PREVIEW" ]; then
    NUDGE_TEXT="[Telegram] ${NUDGE_PREVIEW}"$'\n'"${NUDGE}"
    # Brief overlay in tmux status bar so terminal-watchers see the message
    tmux_s display-message -d 5000 "📨 ${NUDGE_PREVIEW}" 2>/dev/null || true
  fi

  # Send via tmux — ccbot-style, reliable delivery
  tmux_s send-keys -t "$SESSION" "$NUDGE_TEXT"
  sleep 0.3
  tmux_s send-keys -t "$SESSION" "" Enter
  last_nudge=$now
  [ "$highest_pending_id" -gt "$last_nudged_id" ] && last_nudged_id=$highest_pending_id
done
