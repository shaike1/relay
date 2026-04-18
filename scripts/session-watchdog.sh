#!/usr/bin/env bash
# session-watchdog.sh — detect dead/stuck sessions and restart silently
# Run via cron every 10 minutes: */10 * * * * /root/relay/scripts/session-watchdog.sh
set -euo pipefail

LOG="/tmp/session-watchdog.log"
STUCK_MINUTES="${STUCK_MINUTES:-15}"
NOW=$(date +%s)

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }

# Check each relay session container
for container in $(docker ps --filter "name=relay-session-" --format "{{.Names}}" 2>/dev/null); do
    session="${container#relay-session-}"

    # Check if container is healthy
    status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "unknown")
    if [ "$status" = "unhealthy" ]; then
        log "RESTART $container — unhealthy"
        docker restart "$container" > /dev/null 2>&1
        continue
    fi

    # Check last activity via queue file timestamp
    queue_file=$(docker exec "$container" env 2>/dev/null | grep TELEGRAM_THREAD_ID | cut -d= -f2)
    if [ -z "$queue_file" ]; then continue; fi

    last_response_file="/tmp/last-response-${queue_file}.ts"
    if [ -f "$last_response_file" ]; then
        last_ts=$(cat "$last_response_file")
        age=$(( (NOW - last_ts) / 60 ))
        if [ "$age" -gt "$STUCK_MINUTES" ]; then
            # Check if there are pending messages
            pending=$(wc -l < "/tmp/tg-queue-${queue_file}.jsonl" 2>/dev/null || echo 0)
            if [ "$pending" -gt 0 ]; then
                log "RESTART $container — stuck ${age}m with ${pending} pending messages"
                docker restart "$container" > /dev/null 2>&1
            fi
        fi
    fi
done

log "Watchdog check complete"
