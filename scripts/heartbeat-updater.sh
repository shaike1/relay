#!/bin/bash
# heartbeat-updater.sh — Update heartbeats for all local sessions
# Runs from any container that has /tmp shared via relay-queue volume
# Checks actual tmux/claude status for each session

SESSIONS_FILE="${1:-/relay/sessions.json}"

while true; do
  TS=$(date +%s)000

  for session in $(python3 -c "
import json
sessions = json.load(open('$SESSIONS_FILE'))
for s in sessions:
    if not s.get('host'):
        print(s['session'])
" 2>/dev/null); do
    CONTAINER="relay-session-${session}"

    # Check container status
    STATUS="offline"
    TMUX_ACTIVE="false"

    RUNNING=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)
    if [ "$RUNNING" = "true" ]; then
      # Check tmux
      if docker exec "$CONTAINER" tmux has-session -t claude 2>/dev/null; then
        TMUX_ACTIVE="true"
        # Try to detect if idle
        LAST=$(docker exec "$CONTAINER" tmux capture-pane -t claude -p 2>/dev/null | grep -c "." || echo "0")
        if [ "$LAST" -gt 0 ]; then
          STATUS="ready"
        else
          STATUS="idle"
        fi
      else
        STATUS="idle"
      fi
    fi

    cat > "/tmp/heartbeat-${session}.json" <<EOF
{"session":"${session}","status":"${STATUS}","ts":${TS},"tmux_active":${TMUX_ACTIVE}}
EOF
  done

  sleep 60
done
