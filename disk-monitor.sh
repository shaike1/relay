#!/bin/bash
# Disk monitor — alerts via Telegram if usage > 85%

source /root/relay/.env
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="$GROUP_CHAT_ID"
THREAD_ID="${DISK_MONITOR_THREAD_ID:-213}"
THRESHOLD=85

USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
HOST=$(hostname -I | awk '{print $1}')

if [ "$USAGE" -ge "$THRESHOLD" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "message_thread_id=${THREAD_ID}" \
        -d "parse_mode=HTML" \
        --data-urlencode "text=⚠️ <b>דיסק ${USAGE}% מלא!</b>

שרת: <code>${HOST}</code>
נשארו: $(df -h / | tail -1 | awk '{print $4}')

שקול לנקות Docker: <code>docker system prune -af</code>" > /dev/null
fi
