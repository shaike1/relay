#!/bin/bash
# claude-session-loop.sh <session_name> <work_dir>
# Run the Claude Code relay loop for one session.
# In containerized mode (S6_SUPERVISED=1), wraps Claude in a named-socket tmux session
# so the message-watchdog can inject nudges via tmux send-keys, isolated per container.
set -euo pipefail

SESSION="${1:?session name required}"
WORKDIR="${2:?work dir required}"
SESSION_ID_FILE="${WORKDIR}/.relay_session_id"

# Derive the Claude project dir from the working path (mirrors Claude's own logic)
CLAUDE_PROJECT_KEY=$(echo "$WORKDIR" | sed 's|/|-|g; s|[^a-zA-Z0-9._-]|-|g')
PROJECT_DIR="${HOME}/.claude/projects/${CLAUDE_PROJECT_KEY}"

export IS_SANDBOX=1
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

# Proactive check interval (minutes). 0 = disabled (default).
# Set PROACTIVE_INTERVAL=30 in .env to wake Claude every 30 minutes when idle.
PROACTIVE_INTERVAL="${PROACTIVE_INTERVAL:-0}"

# Use a per-session tmux socket so containers don't share a tmux server.
# The socket lives on the shared /tmp volume but each session has its own server.
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"
export TMUX_SOCKET

cd "$WORKDIR"

scrub_telegram_plugin_settings() {
  python3 - "$WORKDIR" <<'PY'
import json
import pathlib
import sys

workdir = pathlib.Path(sys.argv[1])
settings_path = workdir / ".claude" / "settings.json"
if not settings_path.exists():
    raise SystemExit(0)

try:
    data = json.loads(settings_path.read_text())
except Exception:
    raise SystemExit(0)

enabled = data.get("enabledPlugins")
if not isinstance(enabled, dict):
    raise SystemExit(0)

if "telegram@claude-plugins-official" not in enabled:
    raise SystemExit(0)

enabled.pop("telegram@claude-plugins-official", None)
if not enabled:
    data.pop("enabledPlugins", None)

settings_path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

prepare_claude_env() {
  scrub_telegram_plugin_settings
  # Relay sessions use the custom mcp-telegram bridge for outbound delivery.
  # Do not leak the Telegram bot token into Claude itself, or the official
  # Telegram plugin can start polling and steal getUpdates from relay.
  unset TELEGRAM_BOT_TOKEN GROUP_CHAT_ID OWNER_ID
  # Containers currently have DNS answers with IPv6 first/available for model APIs,
  # but no working IPv6 route. Force Node-based clients (Claude Code) to prefer IPv4.
  export NODE_OPTIONS="--dns-result-order=ipv4first"
  if [ "${SESSION_NAME:-}" = "relay" ]; then
    export ANTHROPIC_BASE_URL="http://100.64.0.7:20129"
    export ANTHROPIC_AUTH_TOKEN="sk-221d3a4715adf2a9-8956c3-c6e96698"
    export ANTHROPIC_MODEL="auto-route"
    export ANTHROPIC_SMALL_FAST_MODEL="auto-route"
    unset CLAUDE_CODE_OAUTH_TOKEN
  fi
}

# Helper: run tmux with this session's socket
tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }

# Start MCP server wrapper if this session has a thread_id in sessions.json
THREAD_ID=$(python3 -c "
import json, sys
try:
    sessions = json.load(open('/root/relay/sessions.json'))
    s = next((s for s in sessions if s['session'] == '$SESSION'), None)
    print(s['thread_id'] if s else '')
except Exception:
    print('')
")

if [ -n "$THREAD_ID" ]; then
  export TELEGRAM_THREAD_ID="$THREAD_ID"
  export SESSION_NAME="$SESSION"

  # Auto-generate .mcp.json in the session workdir if missing or has wrong thread.
  # Prevents the codex-session-loop from clobbering /root/.mcp.json and routing
  # this session's MCP to the wrong Telegram topic.
  MCP_JSON_PATH="${WORKDIR}/.mcp.json"
  if [ ! -f "$MCP_JSON_PATH" ] || ! python3 -c "
import json, sys
d = json.load(open('$MCP_JSON_PATH'))
tid = d.get('mcpServers',{}).get('telegram',{}).get('env',{}).get('TELEGRAM_THREAD_ID','')
sys.exit(0 if tid == '$THREAD_ID' else 1)
" 2>/dev/null; then
    python3 -c "
import json
config = {
  'mcpServers': {
    'telegram': {
      'command': '/root/.bun/bin/bun',
      'args': ['run', '--cwd', '/root/relay/mcp-telegram', 'server.ts'],
      'env': {'TELEGRAM_THREAD_ID': '$THREAD_ID', 'SESSION_NAME': '$SESSION'}
    },
    'copilot': {
      'command': '/root/.bun/bin/bun',
      'args': ['run', '--cwd', '/root/relay/mcp-copilot', 'server.ts']
    }
  }
}
with open('$MCP_JSON_PATH', 'w') as f:
    json.dump(config, f, indent=2)
" 2>/dev/null || true
    echo "[session-loop:${SESSION}] wrote .mcp.json (thread=${THREAD_ID})" >&2
  fi

  # Inject persona into CLAUDE.md if set in sessions.json
  python3 -c "
import json, os, sys, pathlib

sessions_file = '/root/relay/sessions.json'
workdir = '$WORKDIR'
session_name = '$SESSION'

try:
    sessions = json.load(open(sessions_file))
    s = next((s for s in sessions if s['session'] == session_name), None)
    persona = s.get('persona', '') if s else ''
except Exception:
    persona = ''

if not persona:
    sys.exit(0)

claude_md = pathlib.Path(workdir) / 'CLAUDE.md'
marker_open = '<!-- AGENT_PERSONA -->'
marker_close = '<!-- /AGENT_PERSONA -->'
persona_block = f'{marker_open}\n## Agent Persona\n{persona}\n{marker_close}\n\n'

if not claude_md.exists():
    claude_md.write_text(persona_block)
else:
    content = claude_md.read_text()
    open_idx = content.find(marker_open)
    close_idx = content.find(marker_close)
    if open_idx != -1 and close_idx != -1 and close_idx > open_idx:
        tail = content[close_idx + len(marker_close):]
        tail = tail.lstrip('\n')
        content = content[:open_idx] + persona_block + tail
    else:
        content = persona_block + content
    claude_md.write_text(content)
print(f'[session-loop:$SESSION] persona injected into CLAUDE.md', file=sys.stderr)
" 2>/dev/null || true

  if [ "${S6_SUPERVISED:-0}" != "1" ]; then
    /root/relay/scripts/mcp-server-wrapper.sh &
    MCP_WRAPPER_PID=$!
    trap "kill $MCP_WRAPPER_PID 2>/dev/null || true" EXIT
  fi

  # Only inject startup message if there are real pending (unprocessed) messages.
  # Injecting unconditionally burns Claude tokens on every container restart even
  # when there is nothing to do — with 15+ sessions this adds up significantly.
  QUEUE_FILE="/tmp/tg-queue-${THREAD_ID}.jsonl"
  HAS_PENDING=$(python3 -c "
import json, os, sys
queue = '/tmp/tg-queue-${THREAD_ID}.jsonl'
state = '/tmp/tg-queue-${THREAD_ID}.state'
if not os.path.exists(queue):
    print('no'); sys.exit()
last_id, last_ts = 0, 0
try:
    s = json.load(open(state))
    last_id = s.get('lastId', 0)
    last_ts = s.get('lastTs', 0)
except Exception:
    pass
for line in open(queue):
    try:
        msg = json.loads(line.strip())
        mid = msg.get('message_id', 0)
        ts = msg.get('ts', 0)
        if mid > 0 and mid > last_id:
            print('yes'); sys.exit()
        if mid < 0 and ts > last_ts:
            print('yes'); sys.exit()
    except Exception:
        pass
print('no')
" 2>/dev/null || echo "no")

  if [ "$HAS_PENDING" = "yes" ]; then
    # Context handoff — inject last session summary if available (< 7 days old)
    SUMMARY_CONTEXT=""
    SUMMARY_FILE="/tmp/session-summary-${SESSION}.md"
    if [ -f "$SUMMARY_FILE" ]; then
      AGE=$(( $(date +%s) - $(stat -c %Y "$SUMMARY_FILE" 2>/dev/null || echo 0) ))
      if [ "$AGE" -lt 604800 ]; then  # 7 days
        SUMMARY_CONTEXT=$(head -c 1000 "$SUMMARY_FILE" 2>/dev/null | sed "s/'/\\\\''/g" || true)
      fi
    fi

    # Read memory keys from per-session key-value store (if present)
    MEMORY_FILE="/tmp/relay-memory-${SESSION}.json"
    MEMORY_KEYS_MSG=""
    if [ -f "$MEMORY_FILE" ]; then
      MEMORY_KEYS_MSG=$(python3 -c "
import json, sys
try:
    data = json.load(open('$MEMORY_FILE'))
    keys = list(data.keys())
    if keys:
        print('Memory keys available: ' + ', '.join(keys) + ' — call memory_read(key) to retrieve')
except Exception:
    pass
" 2>/dev/null || true)
    fi

    if [ -n "$SUMMARY_CONTEXT" ]; then
      STARTUP_MSG='You just started. Previous session context:

'"$SUMMARY_CONTEXT"'
'"${MEMORY_KEYS_MSG:+
$MEMORY_KEYS_MSG
}"'
Call typing then send_message with '"'"'חזרתי ✓ (ממשיך מהיכן שעצרנו)'"'"' then fetch_messages and respond. For purely informational messages use react(👍) instead of a full reply; save full responses for actionable requests.'
    else
      STARTUP_MSG='You just started.'"${MEMORY_KEYS_MSG:+ $MEMORY_KEYS_MSG.}"' Call typing then send_message with '"'"'חזרתי ✓'"'"' to announce you'"'"'re online, then fetch_messages and respond to all pending messages. Tip: for purely informational messages (status updates, FYI), use react(👍) instead of a full reply.'
    fi
    printf '%s\n' "$(python3 -c "
import json, time
print(json.dumps({
    'text': '''$STARTUP_MSG''',
    'user': 'system',
    'message_id': -int(time.time() * 1000),
    'ts': time.time(),
    'force': True
}))
")" >> "$QUEUE_FILE"
  fi
fi

# Proactive check injector — runs in background, wakes Claude on a schedule
# Only active when PROACTIVE_INTERVAL > 0 and a THREAD_ID is known.
if [ -n "$THREAD_ID" ] && [ "$PROACTIVE_INTERVAL" -gt 0 ] 2>/dev/null; then
  (
    PROACTIVE_QUEUE_FILE="/tmp/tg-queue-${THREAD_ID}.jsonl"
    PROACTIVE_INTERVAL_SECS=$(( PROACTIVE_INTERVAL * 60 ))
    # Wait one full interval before first probe so startup messages settle
    sleep "$PROACTIVE_INTERVAL_SECS"
    while true; do
      # Only inject if no real user message arrived in the last interval
      # (avoids interrupting active conversations)
      LAST_USER_TS=$(python3 -c "
import json, time, os
queue = '$PROACTIVE_QUEUE_FILE'
interval = $PROACTIVE_INTERVAL_SECS
if not os.path.exists(queue):
    print(0); exit()
cutoff = time.time() - interval
latest = 0
for line in open(queue):
    try:
        m = json.loads(line.strip())
        mid = m.get('message_id', 0)
        ts = m.get('ts', 0)
        # Only count real user messages (positive IDs, not system injections)
        if mid > 0 and ts > latest:
            latest = ts
    except Exception:
        pass
print(latest)
" 2>/dev/null || echo 0)
      NOW=$(date +%s)
      IDLE_SECS=$(( NOW - ${LAST_USER_TS%.*} ))
      if [ "$IDLE_SECS" -ge "$PROACTIVE_INTERVAL_SECS" ]; then
        python3 -c "
import json, time
print(json.dumps({
    'text': 'Check if there\\'s anything worth proactively reporting to the user — background tasks completed, errors noticed, or important state changes. If nothing notable, call typing() and do not send a message.',
    'user': 'system:proactive',
    'message_id': -int(time.time() * 1000),
    'ts': time.time(),
    'force': True
}))
" >> "$PROACTIVE_QUEUE_FILE" 2>/dev/null || true
      fi
      sleep "$PROACTIVE_INTERVAL_SECS"
    done
  ) &
  PROACTIVE_PID=$!
  trap "kill $PROACTIVE_PID 2>/dev/null || true; ${TRAP_EXIT:-}" EXIT
fi

# Inner loop script that Claude runs inside tmux
INNER_SCRIPT=$(mktemp /tmp/claude-inner-${SESSION}-XXXXXX.sh)
cat > "$INNER_SCRIPT" <<INNER
#!/bin/bash
set -euo pipefail
export IS_SANDBOX=1
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
export TELEGRAM_THREAD_ID="${TELEGRAM_THREAD_ID:-}"
export SESSION_NAME="${SESSION}"
# Load OAuth token from .env for persistent auth (valid 1 year)
OAUTH_TOKEN=\$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' /root/relay/.env 2>/dev/null | cut -d= -f2)
[ -n "\$OAUTH_TOKEN" ] && export CLAUDE_CODE_OAUTH_TOKEN="\$OAUTH_TOKEN"
cd "$WORKDIR"
$(declare -f scrub_telegram_plugin_settings)
$(declare -f prepare_claude_env)
while true; do
  prepare_claude_env
  if [ -f "$SESSION_ID_FILE" ]; then
    SID=\$(cat "$SESSION_ID_FILE")
    claude --dangerously-skip-permissions --permission-mode auto --remote-control --resume "\$SID" 2>/dev/null \
      || claude --dangerously-skip-permissions --permission-mode auto --remote-control --continue 2>/dev/null \
      || claude --dangerously-skip-permissions --permission-mode auto --remote-control 2>/dev/null \
      || true
  else
    claude --dangerously-skip-permissions --permission-mode auto --remote-control --continue 2>/dev/null \
      || claude --dangerously-skip-permissions --permission-mode auto --remote-control 2>/dev/null \
      || true
  fi

  # Save latest session ID for next resume
  LATEST=\$(ls -t "${PROJECT_DIR}"/*.jsonl 2>/dev/null | head -1 || true)
  if [ -n "\$LATEST" ]; then
    basename "\$LATEST" .jsonl > "$SESSION_ID_FILE"
  fi

  sleep 1
done
INNER
chmod +x "$INNER_SCRIPT"

if [ "${S6_SUPERVISED:-0}" = "1" ]; then
  # Container mode: run Claude inside an isolated tmux session.
  # Kill stale session/socket, then start fresh.
  tmux_s kill-server 2>/dev/null || true
  rm -f "$TMUX_SOCKET"

  tmux_s new-session -d -s "$SESSION" -c "$WORKDIR" "bash $INNER_SCRIPT"

  # Wait for the tmux session to exit, then s6 will restart.
  while tmux_s has-session -t "$SESSION" 2>/dev/null; do
    sleep 2
  done

  rm -f "$INNER_SCRIPT"
else
  # Non-container mode: run Claude directly (legacy host tmux mode)
  rm -f "$INNER_SCRIPT"

  while true; do
    prepare_claude_env
    if [ -f "$SESSION_ID_FILE" ]; then
      SID=$(cat "$SESSION_ID_FILE")
      claude --dangerously-skip-permissions --permission-mode auto --remote-control --resume "$SID" 2>/dev/null \
        || claude --dangerously-skip-permissions --permission-mode auto --remote-control --continue 2>/dev/null \
        || claude --dangerously-skip-permissions --permission-mode auto --remote-control 2>/dev/null \
        || true
    else
      claude --dangerously-skip-permissions --permission-mode auto --remote-control --continue 2>/dev/null \
        || claude --dangerously-skip-permissions --permission-mode auto --remote-control 2>/dev/null \
        || true
    fi

    LATEST=$(ls -t "${PROJECT_DIR}"/*.jsonl 2>/dev/null | head -1 || true)
    if [ -n "$LATEST" ]; then
      basename "$LATEST" .jsonl > "$SESSION_ID_FILE"
    fi

    sleep 1
  done
fi
