#!/bin/bash
# Runs docker system prune -af once a week (every 7 days)
INTERVAL=$((7 * 24 * 3600))
LOG=/var/log/docker-prune.log

while true; do
    sleep "$INTERVAL"
    echo "[$(date -Iseconds)] Running docker system prune -af" >> "$LOG"
    docker system prune -af >> "$LOG" 2>&1
    echo "[$(date -Iseconds)] Done" >> "$LOG"
done
