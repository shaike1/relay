#!/bin/sh
# graceful-shutdown.sh — called when the session container is shutting down
# Reads BOT_TOKEN, GROUP_CHAT_ID from /root/relay/.env; SESSION, TELEGRAM_THREAD_ID from env

# Load .env if needed
if [ -f /root/relay/.env ]; then
  # shellcheck disable=SC1090
  while IFS= read -r line; do
    case "$line" in
      \#*|'') continue ;;
      *=*)
        key="${line%%=*}"
        val="${line#*=}"
        # Only set if not already in environment
        eval "[ -z \"\${${key}+x}\" ] && export ${key}=\"${val}\""
        ;;
    esac
  done < /root/relay/.env
fi

SESSION="${SESSION_NAME:-${SESSION:-unknown}}"
THREAD_ID="${TELEGRAM_THREAD_ID:-}"
BOT_TOKEN="${BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
CHAT_ID="${GROUP_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"

TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

# Save context note
if [ -n "${THREAD_ID}" ]; then
  SUMMARY_FILE="/tmp/session-summary-${SESSION}.md"
  printf "Session stopped at %s. Container shutting down.\n" "${TIMESTAMP}" > "${SUMMARY_FILE}"
fi

# Send Telegram notification
if [ -n "${BOT_TOKEN}" ] && [ -n "${CHAT_ID}" ]; then
  MSG="🔴 סשן <b>${SESSION}</b> נכבה"
  PAYLOAD="{\"chat_id\":\"${CHAT_ID}\",\"text\":\"${MSG}\",\"parse_mode\":\"HTML\""
  if [ -n "${THREAD_ID}" ]; then
    PAYLOAD="${PAYLOAD},\"message_thread_id\":${THREAD_ID}"
  fi
  PAYLOAD="${PAYLOAD}}"

  curl -s -X POST \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}" \
    --max-time 10 \
    > /dev/null 2>&1 || true
fi

echo "[graceful-shutdown] Session ${SESSION} stopped at ${TIMESTAMP}"
