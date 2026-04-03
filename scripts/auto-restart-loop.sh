#!/bin/bash
# auto-restart-loop.sh — Monitor sessions and auto-restart crashed containers
# Runs every 60s, restarts containers that are exited/dead
set -euo pipefail

SESSIONS_FILE="/root/relay/sessions.json"
LOG="/tmp/auto-restart.log"
CHECK_INTERVAL=60

echo "[$(date)] Auto-restart watchdog started" >> "$LOG"

while true; do
    # Read session names from sessions.json
    NAMES=$(python3 -c "
import json, sys
try:
    sessions = json.load(open('$SESSIONS_FILE'))
    for s in sessions:
        host = s.get('host')
        # Only manage local containers (no host or null host)
        if not host:
            print(s['session'])
except: pass
" 2>/dev/null)

    for name in $NAMES; do
        container="relay-session-${name}"
        status=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo "not_found")

        if [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
            echo "[$(date)] Restarting $container (was: $status)" >> "$LOG"
            docker start "$container" >> "$LOG" 2>&1 || true
            sleep 2
            new_status=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo "unknown")
            echo "[$(date)] $container now: $new_status" >> "$LOG"
        fi
    done

    sleep "$CHECK_INTERVAL"
done
