#!/bin/bash
# Relay self-monitor on .7 — attempts restart and sends direct Telegram alert

source /root/relay/.env
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="$GROUP_CHAT_ID"
THREAD_ID="${SELF_MONITOR_THREAD_ID:-183}"
ALERT_FILE="/tmp/relay-alert-sent"

send_alert() {
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "message_thread_id=${THREAD_ID}" \
        -d "parse_mode=HTML" \
        --data-urlencode "text=$1" > /dev/null
}

if ! systemctl is-active --quiet relay; then
    if [ ! -f "$ALERT_FILE" ]; then
        touch "$ALERT_FILE"
        # Try restart first
        systemctl restart relay
        sleep 5
        if systemctl is-active --quiet relay; then
            send_alert "⚠️ <b>Relay (.7) was down — auto-restarted successfully</b>

Time: $(date -u '+%Y-%m-%d %H:%M UTC')"
            rm "$ALERT_FILE"
        else
            send_alert "🚨 <b>Relay (.7) DOWN — restart failed</b>

systemctl restart relay failed.
Backup relay on .12 should activate within 45s.
Time: $(date -u '+%Y-%m-%d %H:%M UTC')"
        fi
    fi
else
    [ -f "$ALERT_FILE" ] && rm "$ALERT_FILE"
fi
exit 0
