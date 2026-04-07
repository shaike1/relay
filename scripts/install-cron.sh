#!/usr/bin/env bash
# install-cron.sh — Install system crontab entries for relay automation
# Adds: daily backup at 2am
set -euo pipefail

RELAY_DIR="/root/relay"
BACKUP_SCRIPT="${RELAY_DIR}/scripts/backup.sh"
LOG_FILE="/var/log/relay-backup.log"

# Ensure backup script is executable
chmod +x "$BACKUP_SCRIPT"

CRON_LINE="0 2 * * * $BACKUP_SCRIPT >> $LOG_FILE 2>&1"
MARKER="relay-backup"

# Check if already installed
if crontab -l 2>/dev/null | grep -q "$MARKER"; then
  echo "[install-cron] Backup cron already installed. Skipping."
  crontab -l | grep "$MARKER"
  exit 0
fi

# Add to crontab
(crontab -l 2>/dev/null || echo ""; echo "# $MARKER"; echo "$CRON_LINE") | crontab -

echo "[install-cron] Installed daily backup cron:"
echo "  $CRON_LINE"
echo ""
echo "[install-cron] Current crontab:"
crontab -l
