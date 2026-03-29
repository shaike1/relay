#!/bin/bash
# claude-session-loop.sh <session_name> <work_dir>
# Run the Claude Code relay loop for one session.
# Designed to run inside a tmux pane; restarts Claude on exit.
set -euo pipefail

SESSION="${1:?session name required}"
WORKDIR="${2:?work dir required}"
SESSION_ID_FILE="${WORKDIR}/.relay_session_id"

# Derive the Claude project dir from the working path (mirrors Claude's own logic)
# /root/relay → -root-relay,  /root/.openclaw/workspace → -root--openclaw-workspace
CLAUDE_PROJECT_KEY=$(echo "$WORKDIR" | sed 's|/|-|g; s|[^a-zA-Z0-9._-]|-|g')
PROJECT_DIR="${HOME}/.claude/projects/${CLAUDE_PROJECT_KEY}"

CLAUDE_CMD="IS_SANDBOX=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  claude --dangerously-skip-permissions --permission-mode auto --remote-control"

export IS_SANDBOX=1
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

cd "$WORKDIR"

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
  # In containerized mode (S6_SUPERVISED=1), the mcp-server service is managed
  # by s6-overlay separately — skip launching it here to avoid duplication.
  if [ "${S6_SUPERVISED:-0}" != "1" ]; then
    /root/relay/scripts/mcp-server-wrapper.sh &
    MCP_WRAPPER_PID=$!
    trap "kill $MCP_WRAPPER_PID 2>/dev/null || true" EXIT
  fi
fi

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

  # Save latest session ID for next resume
  LATEST=$(ls -t "${PROJECT_DIR}"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    basename "$LATEST" .jsonl > "$SESSION_ID_FILE"
  fi

  sleep 1
done
