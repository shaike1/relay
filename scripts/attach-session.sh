#!/bin/bash
# attach-session.sh <session_name> [host]
# Attach to the tmux session running inside a relay session container.
#
# Usage:
#   ./scripts/attach-session.sh cliproxy           # local container
#   ./scripts/attach-session.sh edushare root@your-remote-host  # remote container
set -euo pipefail

SESSION="${1:?session name required}"
HOST="${2:-}"

CONTAINER="relay-session-${SESSION}"
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"

CMD="docker exec -it ${CONTAINER} tmux -S ${TMUX_SOCKET} attach -t ${SESSION}"

if [ -n "$HOST" ]; then
    ssh -t "$HOST" "$CMD"
else
    eval "$CMD"
fi
