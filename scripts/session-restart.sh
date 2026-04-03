#!/bin/bash
# session-restart.sh — Restart a relay session container
# Usage: session-restart.sh <session-name>
set -euo pipefail

SESSION="${1:?Usage: session-restart.sh <session-name>}"
CONTAINER="relay-session-${SESSION}"

# Check if container exists
STATUS=$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "not_found")

if [ "$STATUS" = "not_found" ]; then
    echo '{"ok":false,"error":"container not found"}'
    exit 1
fi

if [ "$STATUS" = "running" ]; then
    docker restart "$CONTAINER" --timeout 10 2>&1
else
    docker start "$CONTAINER" 2>&1
fi

# Verify
sleep 2
NEW_STATUS=$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")
echo "{\"ok\":true,\"session\":\"${SESSION}\",\"previous\":\"${STATUS}\",\"current\":\"${NEW_STATUS}\"}"
