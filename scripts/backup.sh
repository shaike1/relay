#!/usr/bin/env bash
# backup.sh — Relay auto-backup script
# Creates timestamped backups of critical relay files and sends Telegram notification
set -euo pipefail

RELAY_DIR="/root/relay"
BACKUP_DIR="/root/relay-backups"
KEEP=7

# Load env
ENV_FILE="${RELAY_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${GROUP_CHAT_ID:-}"

# Files & Config topic for sending backup files (thread 11351)
FILES_THREAD_ID="${FILES_THREAD_ID:-11351}"

# Get ALERT_THREAD_ID or first session thread_id
THREAD_ID="${ALERT_THREAD_ID:-}"
if [[ -z "$THREAD_ID" ]] && [[ -f "${RELAY_DIR}/sessions.json" ]]; then
  THREAD_ID=$(python3 -c "import json,sys; s=json.load(open('${RELAY_DIR}/sessions.json')); print(s[0]['thread_id'])" 2>/dev/null || echo "")
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

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/relay-backup-${TIMESTAMP}.tar.gz"
TMP_STAGE="/tmp/relay-backup-stage-${TIMESTAMP}"
mkdir -p "$TMP_STAGE"

echo "[backup] Starting backup at $TIMESTAMP"

# Collect files to backup
FILES_TO_BACKUP=()

for f in \
  "${RELAY_DIR}/sessions.json" \
  "${RELAY_DIR}/.env" \
  "${RELAY_DIR}/schedules.json" \
  "${RELAY_DIR}/docker-compose.yml" \
  "${RELAY_DIR}/docker-compose.sessions.yml"
do
  if [[ -f "$f" ]]; then
    FILES_TO_BACKUP+=("$f")
    echo "[backup] Including: $f"
  else
    echo "[backup] Missing (skipped): $f"
  fi
done

# Knowledge and token stat files from relay-queue volume (mounted at /tmp in containers)
for pattern in "/tmp/relay-knowledge*.jsonl" "/tmp/token-stats*.jsonl"; do
  for f in $pattern; do
    if [[ -f "$f" ]]; then
      FILES_TO_BACKUP+=("$f")
      echo "[backup] Including: $f"
    fi
  done
done

if [[ ${#FILES_TO_BACKUP[@]} -eq 0 ]]; then
  echo "[backup] No files found to backup!"
  tg_notify "⚠️ גיבוי נכשל — לא נמצאו קבצים לגיבוי"
  exit 1
fi

# Create archive
tar -czf "$BACKUP_FILE" "${FILES_TO_BACKUP[@]}" 2>/dev/null || {
  echo "[backup] tar failed"
  tg_notify "⚠️ גיבוי נכשל — שגיאה ביצירת ארכיב"
  exit 1
}

echo "[backup] Created: $BACKUP_FILE"

# Prune old backups — keep only last $KEEP
mapfile -t old_backups < <(ls -t "${BACKUP_DIR}"/relay-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
for old in "${old_backups[@]}"; do
  echo "[backup] Removing old backup: $old"
  rm -f "$old"
done

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "[backup] Done. Size: $SIZE"

# Telegram notification
BACKUP_NAME="relay-backup-${TIMESTAMP}.tar.gz"
tg_notify "✅ גיבוי הושלם — ${BACKUP_NAME} (${SIZE}) — נשלח לטופיק Files &amp; Config"

# Send backup file to Files & Config topic
if [[ -n "$BOT_TOKEN" && -n "$CHAT_ID" && -n "$FILES_THREAD_ID" ]]; then
  curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
    -F chat_id="${CHAT_ID}" \
    -F message_thread_id="${FILES_THREAD_ID}" \
    -F document="@${BACKUP_FILE}" \
    -F caption="📦 ${BACKUP_NAME} (${SIZE}) — $(date '+%Y-%m-%d %H:%M')" \
    --max-time 30 > /dev/null 2>&1 || echo "[backup] Warning: failed to send file to Files topic"
fi

echo "[backup] Backup complete: $BACKUP_FILE"
