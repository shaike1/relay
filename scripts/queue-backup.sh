#!/bin/bash
# queue-backup.sh — Backup queue files to persistent storage
# Runs every 5 minutes via cron. Restores on empty /tmp.
set -euo pipefail

BACKUP_DIR="/root/relay/queues-backup"
QUEUE_DIR="/tmp"
MAX_AGE_HOURS=24

mkdir -p "$BACKUP_DIR"

# --- Backup: copy current queues to backup dir ---
backup() {
    local count=0
    for f in "$QUEUE_DIR"/tg-queue-*.jsonl "$QUEUE_DIR"/tg-queue-*.state "$QUEUE_DIR"/tg-last-sent-*; do
        [ -f "$f" ] || continue
        local base=$(basename "$f")
        # Only copy if source is newer than backup
        if [ ! -f "$BACKUP_DIR/$base" ] || [ "$f" -nt "$BACKUP_DIR/$base" ]; then
            cp -p "$f" "$BACKUP_DIR/$base"
            count=$((count + 1))
        fi
    done
    [ $count -gt 0 ] && echo "Backed up $count files to $BACKUP_DIR"
}

# --- Restore: if queue dir is empty, restore from backup ---
restore() {
    # Check if any queue files exist in /tmp
    local has_queues=false
    for f in "$QUEUE_DIR"/tg-queue-*.jsonl; do
        [ -f "$f" ] && has_queues=true && break
    done

    if [ "$has_queues" = false ]; then
        local count=0
        for f in "$BACKUP_DIR"/tg-queue-*.jsonl "$BACKUP_DIR"/tg-queue-*.state "$BACKUP_DIR"/tg-last-sent-*; do
            [ -f "$f" ] || continue
            cp -p "$f" "$QUEUE_DIR/$(basename "$f")"
            count=$((count + 1))
        done
        [ $count -gt 0 ] && echo "Restored $count files from backup"
    fi
}

# --- Cleanup: remove old backup snapshots ---
cleanup() {
    find "$BACKUP_DIR" -name "tg-queue-*.jsonl.*.bak" -mmin +$((MAX_AGE_HOURS * 60)) -delete 2>/dev/null || true
}

case "${1:-backup}" in
    backup)  backup ;;
    restore) restore ;;
    auto)    restore; backup; cleanup ;;
    *)       echo "Usage: $0 {backup|restore|auto}" ;;
esac
