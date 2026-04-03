#!/bin/bash
# tg-send.sh — Simple wrapper for sending Telegram messages from copilot sessions.
# Usage: tg-send "message text"
#        tg-send --typing
# Always sends to the correct topic thread. HTML supported.
set -euo pipefail

# Load credentials from .env
if [ -f /root/relay/.env ]; then
  BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN /root/relay/.env | cut -d= -f2)
  CHAT_ID=$(grep GROUP_CHAT_ID /root/relay/.env | cut -d= -f2)
fi
THREAD_ID="${TELEGRAM_THREAD_ID:-8928}"

if [ "${1:-}" = "--typing" ]; then
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction" \
    -d chat_id="${CHAT_ID}" \
    -d message_thread_id="${THREAD_ID}" \
    -d action=typing > /dev/null
  exit 0
fi

TEXT="${1:?Usage: tg-send \"message text\"}"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d message_thread_id="${THREAD_ID}" \
  -d parse_mode=HTML \
  --data-urlencode "text=${TEXT}"
