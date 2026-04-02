#!/bin/bash
# Relay watchdog: monitor primary (.7) and take over if it goes down.
# Only one relay bot may poll Telegram at a time, so this script keeps the
# backup bot in strict standby until the primary probe fails repeatedly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${RELAY_ENV_FILE:-$SCRIPT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

PRIMARY="${RELAY_PRIMARY:-root@your-primary-host}"
PRIMARY_CHECK_CMD="${RELAY_PRIMARY_CHECK_CMD:-if docker inspect -f '{{.State.Running}}' relay 2>/dev/null | grep -qx true; then exit 0; fi; systemctl is-active --quiet relay;}"
PRIMARY_TIMEOUT="${RELAY_PRIMARY_TIMEOUT:-5}"
LOCAL_SERVICE="${RELAY_LOCAL_SERVICE:-relay}"
STATE_FILE="${RELAY_WATCHDOG_STATE_FILE:-/tmp/relay-watchdog.state}"

FAIL_COUNT=0
MAX_FAILS=3       # 3 x 15s = 45s before failover
CHECK_INTERVAL=15
ACTIVE_STATE=0

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-${GROUP_CHAT_ID:-}}"
THREAD_ID="${TELEGRAM_THREAD_ID:-183}"  # relay topic

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"; }

load_state() {
    if [ -f "$STATE_FILE" ]; then
        # shellcheck disable=SC1090
        . "$STATE_FILE"
    fi
    ACTIVE_STATE="${ACTIVE_STATE:-0}"
}

save_state() {
    printf 'ACTIVE_STATE=%s\n' "$ACTIVE_STATE" > "$STATE_FILE"
}

send_alert() {
    local text="$1"
    if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ] || [ -z "$THREAD_ID" ]; then
        log "Alert skipped — missing TELEGRAM_BOT_TOKEN/chat/thread config"
        return
    fi
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "message_thread_id=${THREAD_ID}" \
        -d "parse_mode=HTML" \
        --data-urlencode "text=${text}" > /dev/null || true
}

primary_healthy() {
    ssh -o BatchMode=yes -o ConnectTimeout="$PRIMARY_TIMEOUT" -o StrictHostKeyChecking=no "$PRIMARY" \
        "bash -lc \"$PRIMARY_CHECK_CMD\"" >/dev/null 2>&1
}

local_state() {
    systemctl is-active "$LOCAL_SERVICE" 2>/dev/null || true
}

local_failed_state() {
    systemctl is-failed "$LOCAL_SERVICE" 2>/dev/null || true
}

enforce_standby() {
    local state failed
    state="$(local_state)"
    failed="$(local_failed_state)"

    if [ "$state" = "inactive" ] && [ "$failed" != "failed" ]; then
        return 1
    fi

    log "Primary healthy — enforcing standby on backup relay (state=${state:-unknown} failed=${failed:-unknown})"
    systemctl stop "$LOCAL_SERVICE" >/dev/null 2>&1 || true
    systemctl reset-failed "$LOCAL_SERVICE" >/dev/null 2>&1 || true
    return 0
}

start_backup_relay() {
    log "Primary (.7) down — starting backup relay on standby host"
    systemctl reset-failed "$LOCAL_SERVICE" >/dev/null 2>&1 || true
    systemctl start "$LOCAL_SERVICE"
    sleep 2
    [ "$(local_state)" = "active" ]
}

load_state
save_state

while true; do
    if primary_healthy; then
        FAIL_COUNT=0
        standby_changed=0
        if enforce_standby; then
            standby_changed=1
        fi

        if [ "$ACTIVE_STATE" = "1" ]; then
            ACTIVE_STATE=0
            save_state
            if [ "$standby_changed" = "1" ]; then
                send_alert "✅ <b>Relay primary (.7) recovered</b>

Backup relay on .12 stopped.
Time: $(date -u '+%Y-%m-%d %H:%M UTC')"
            fi
        fi
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        log "Primary check failed (${FAIL_COUNT}/${MAX_FAILS})"

        if [ "$FAIL_COUNT" -ge "$MAX_FAILS" ]; then
            if [ "$ACTIVE_STATE" = "0" ]; then
                if start_backup_relay; then
                    ACTIVE_STATE=1
                    save_state
                    send_alert "🚨 <b>Relay primary (.7) is down</b>

Backup relay activated on .12.
.12-hosted sessions continue working.
.7-hosted sessions remain unavailable until .7 recovers.
Time: $(date -u '+%Y-%m-%d %H:%M UTC')"
                else
                    log "Failed to start backup relay service '${LOCAL_SERVICE}'"
                fi
            elif [ "$(local_state)" != "active" ]; then
                log "Backup relay should be active but service state is '$(local_state)' — retrying start"
                start_backup_relay || log "Retry start failed for backup relay service '${LOCAL_SERVICE}'"
            fi
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
