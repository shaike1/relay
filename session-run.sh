#!/bin/bash
# session-run.sh — run a command in a session's project dir, then restart Claude
#
# Usage:
#   ./session-run.sh <session-name> [command...]
#
# Examples:
#   ./session-run.sh edushare claude mcp add-json stitch '{"command":"...","args":["proxy"]}'  -s local
#   ./session-run.sh edushare   # just restart, no command
#
# Looks up host and path from sessions.json automatically.

set -euo pipefail

SESSIONS_FILE="$(dirname "$0")/sessions.json"

SESSION="${1:-}"
if [[ -z "$SESSION" ]]; then
  echo "Usage: $0 <session-name> [command...]"
  exit 1
fi
shift

# Look up session config
HOST=$(jq -r --arg s "$SESSION" '.[] | select(.session==$s) | .host // ""' "$SESSIONS_FILE")
PATH_=$(jq -r --arg s "$SESSION" '.[] | select(.session==$s) | .path' "$SESSIONS_FILE")

if [[ -z "$PATH_" ]]; then
  echo "Session '$SESSION' not found in sessions.json"
  exit 1
fi

echo "Session: $SESSION | Host: ${HOST:-local} | Path: $PATH_"

# Run command if provided
if [[ $# -gt 0 ]]; then
  echo "Running: $*"
  if [[ -n "$HOST" ]]; then
    ssh -o StrictHostKeyChecking=no "$HOST" "cd '$PATH_' && $*"
  else
    (cd "$PATH_" && "$@")
  fi
  echo "Command done."
fi

# Restart Claude (send 'q Enter' to quit gracefully, loop restarts it)
echo "Restarting Claude in tmux session '$SESSION'..."
if [[ -n "$HOST" ]]; then
  ssh -o StrictHostKeyChecking=no "$HOST" "tmux send-keys -t '$SESSION' q Enter"
else
  tmux send-keys -t "$SESSION" q Enter
fi

echo "Done. Claude will restart automatically via the loop."
