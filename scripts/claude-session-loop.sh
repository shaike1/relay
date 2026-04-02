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
  if [ "${S6_SUPERVISED:-0}" != "1" ]; then
    /root/relay/scripts/mcp-server-wrapper.sh &
    MCP_WRAPPER_PID=$!
    trap "kill $MCP_WRAPPER_PID 2>/dev/null || true" EXIT
  fi

  # Inject a startup message so Claude knows to announce itself and check context.
  # This ensures sessions are productive immediately after restart, not idle.
  QUEUE_FILE="/tmp/tg-queue-${THREAD_ID}.jsonl"
  STARTUP_MSG='You just started. Call typing then send_message with '"'"'חזרתי ✓'"'"' to announce you'"'"'re online, then fetch_messages and respond to all pending messages.'
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

# Inner loop script that Claude runs inside tmux
INNER_SCRIPT=$(mktemp /tmp/claude-inner-${SESSION}-XXXXXX.sh)
cat > "$INNER_SCRIPT" <<INNER
#!/bin/bash
set -euo pipefail
export IS_SANDBOX=1
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
export TELEGRAM_THREAD_ID="${TELEGRAM_THREAD_ID:-}"
export SESSION_NAME="${SESSION}"
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
