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
