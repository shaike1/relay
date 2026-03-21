#!/bin/bash
# Relay watchdog: monitor primary (.7) and take over if it goes down

PRIMARY="root@your-primary-host"
FAIL_COUNT=0
MAX_FAILS=3       # 3 x 15s = 45s before failover
CHECK_INTERVAL=15
ACTIVE=false

BOT_TOKEN="YOUR_BOT_TOKEN"
CHAT_ID="-1003865448408"
THREAD_ID="183"  # relay topic

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"; }

send_alert() {
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "message_thread_id=${THREAD_ID}" \
        -d "parse_mode=HTML" \
        --data-urlencode "text=$1" > /dev/null
}

while true; do
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$PRIMARY" \
        "systemctl is-active --quiet relay" 2>/dev/null; then
        # Primary is alive
        if $ACTIVE; then
            log "Primary (.7) recovered — stopping backup relay"
            systemctl stop relay
            ACTIVE=false
            send_alert "✅ <b>Relay primary (.7) recovered</b>

Backup relay on .12 stopped.
Time: $(date -u '+%Y-%m-%d %H:%M UTC')"
        fi
        FAIL_COUNT=0
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        log "Primary check failed (${FAIL_COUNT}/${MAX_FAILS})"

        if [ $FAIL_COUNT -ge $MAX_FAILS ] && ! $ACTIVE; then
            log "Primary (.7) down — starting backup relay on .12"
            systemctl start relay
            ACTIVE=true
            send_alert "🚨 <b>Relay primary (.7) is down</b>

Backup relay activated on .12.
.12-hosted sessions continue working.
.7-hosted sessions (main, openclaw, voice, cliproxy...) unavailable until .7 recovers.
Time: $(date -u '+%Y-%m-%d %H:%M UTC')"
        fi
    fi

    sleep $CHECK_INTERVAL
done
