#!/bin/bash
# session-logs.sh — Get recent logs from a session container
# Usage: session-logs.sh <session-name> [lines]
set -euo pipefail

SESSION="${1:?Usage: session-logs.sh <session-name> [lines]}"
LINES="${2:-30}"

CONTAINER="relay-session-${SESSION}"

docker logs "$CONTAINER" --tail "$LINES" 2>&1 || echo "Error: could not get logs for $CONTAINER"
