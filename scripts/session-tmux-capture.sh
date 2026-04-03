#!/bin/bash
# session-tmux-capture.sh — Capture current tmux output for a session
# Usage: session-tmux-capture.sh <session-name> [lines]
set -euo pipefail

SESSION="${1:?Usage: session-tmux-capture.sh <session-name> [lines]}"
LINES="${2:-50}"
CONTAINER="relay-session-${SESSION}"
SOCK="/tmp/tmux-${SESSION}.sock"

docker exec "$CONTAINER" tmux -S "$SOCK" capture-pane -t "$SESSION" -p -S "-${LINES}" 2>&1 || echo "Error: could not capture tmux for $SESSION"
