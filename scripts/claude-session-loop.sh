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
while true; do
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
