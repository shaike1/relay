#!/usr/bin/env bash
# restore.sh — Restore relay backup from tar.gz
# Usage: restore.sh <backup-file.tar.gz>
set -euo pipefail

RELAY_DIR="/root/relay"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup-file.tar.gz>"
  exit 1
fi

BACKUP_FILE="$1"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[restore] Error: backup file not found: $BACKUP_FILE"
  exit 1
fi

# Load env for Telegram notification
ENV_FILE="${RELAY_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${GROUP_CHAT_ID:-}"
THREAD_ID="${ALERT_THREAD_ID:-}"
if [[ -z "$THREAD_ID" ]] && [[ -f "${RELAY_DIR}/sessions.json" ]]; then
  THREAD_ID=$(python3 -c "import json; s=json.load(open('${RELAY_DIR}/sessions.json')); print(s[0]['thread_id'])" 2>/dev/null || echo "")
fi

tg_notify() {
  local text="$1"
  if [[ -n "$BOT_TOKEN" && -n "$CHAT_ID" && -n "$THREAD_ID" ]]; then
    curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="${CHAT_ID}" \
      -d message_thread_id="${THREAD_ID}" \
      -d text="${text}" \
      -d parse_mode="HTML" \
      --max-time 10 > /dev/null 2>&1 || true
  fi
}

RESTORE_TMP="/tmp/relay-restore"
rm -rf "$RESTORE_TMP"
mkdir -p "$RESTORE_TMP"

echo "[restore] Extracting: $BACKUP_FILE"
tar -xzf "$BACKUP_FILE" -C "$RESTORE_TMP" 2>/dev/null || {
  echo "[restore] Failed to extract archive"
  exit 1
}

echo "[restore] Extracted files:"
find "$RESTORE_TMP" -type f | while read -r f; do
  echo "  $f"
done

# Restore relay config files to their correct locations
restore_file() {
  local src="$1"
  local dest="$2"
  if [[ -f "$src" ]]; then
    echo "[restore] Restoring: $src -> $dest"
    cp "$src" "$dest"
  fi
}

# Files from /root/relay/ — strip leading path when restoring
for f in $(find "$RESTORE_TMP" -type f); do
  # Reconstruct original path by stripping /tmp/relay-restore prefix
  orig="${f#${RESTORE_TMP}}"
  if [[ -n "$orig" && "$orig" != "/" ]]; then
    dest_dir=$(dirname "$orig")
    if [[ -d "$dest_dir" ]]; then
      echo "[restore] Copying $orig"
      cp "$f" "$orig"
    else
      echo "[restore] Skipping (dest dir missing): $orig"
    fi
  fi
done

BACKUP_NAME=$(basename "$BACKUP_FILE")
echo "[restore] Restore complete from $BACKUP_NAME"
tg_notify "✅ שחזור הושלם מ-${BACKUP_NAME}"
