#!/bin/bash
# heartbeat.sh — Report session heartbeat to orchestrator
# Usage: heartbeat.sh <session-name> [status] [interval]
# Runs in a loop, writing heartbeat file to shared /tmp

SESSION="${1:?Usage: heartbeat.sh <session-name> [status] [interval]}"
STATUS="${2:-ready}"
INTERVAL="${3:-60}"

while true; do
  UPTIME=$(cat /proc/uptime 2>/dev/null | awk '{print int($1)}')

  # Check if Claude/tmux is active
  TMUX_ACTIVE="false"
  if tmux has-session -t claude 2>/dev/null; then
    TMUX_ACTIVE="true"
    # Check recent activity
    LAST_OUTPUT=$(tmux capture-pane -t claude -p 2>/dev/null | tail -1)
    if echo "$LAST_OUTPUT" | grep -q "Waiting for input\|Human:\|idle"; then
      STATUS="idle"
    else
      STATUS="busy"
    fi
  fi

  cat > "/tmp/heartbeat-${SESSION}.json" <<EOF
{
  "session": "${SESSION}",
  "status": "${STATUS}",
  "ts": $(date +%s%3N),
  "uptime": ${UPTIME:-0},
  "tmux_active": ${TMUX_ACTIVE}
}
EOF

  sleep "$INTERVAL"
done
