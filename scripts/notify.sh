#!/bin/bash
# notify.sh — send a direct Telegram DM to NOTIFY_USER_ID.
# Usage: notify.sh "message text"
#
# Sends a DM directly to the owner's Telegram user (not the group topic).
# Falls back to tg-send (group topic) if NOTIFY_USER_ID is not set.
#
# Used by backup.sh, upgrade.sh, and other scripts that need to alert the user
# about background task completion or critical errors.

set -euo pipefail

MSG="${1:?Usage: notify.sh <message text>}"

# Load env if not already in environment
ENV_FILE="${RELAY_ENV:-/root/relay/.env}"
if [ -f "$ENV_FILE" ] && [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE" 2>/dev/null || true; set +a
fi

NOTIFY_USER_ID="${NOTIFY_USER_ID:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

if [ -z "$NOTIFY_USER_ID" ] || [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  # Fallback: send to group topic via tg-send
  if command -v tg-send >/dev/null 2>&1; then
    tg-send "$MSG" 2>/dev/null || true
  else
    echo "[notify] No NOTIFY_USER_ID set and tg-send not available — message dropped: $MSG" >&2
  fi
  exit 0
fi

# Send direct DM to NOTIFY_USER_ID
RESPONSE=$(curl -sf -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\":\"${NOTIFY_USER_ID}\",\"text\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$MSG"),\"parse_mode\":\"HTML\"}" \
  2>/dev/null) || true

if echo "${RESPONSE:-}" | grep -q '"ok":true'; then
  echo "[notify] DM sent to user ${NOTIFY_USER_ID}" >&2
else
  # Fallback to group topic on failure
  if command -v tg-send >/dev/null 2>&1; then
    tg-send "$MSG" 2>/dev/null || true
  fi
  echo "[notify] DM failed, fell back to tg-send" >&2
fi
