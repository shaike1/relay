#!/bin/bash
# queue-backup-loop.sh — Continuous queue backup daemon
# Runs restore once on startup, then backs up every 5 minutes
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Queue backup daemon starting..."

# Restore on startup if needed
bash "$SCRIPT_DIR/queue-backup.sh" restore

while true; do
    sleep 300  # 5 minutes
    bash "$SCRIPT_DIR/queue-backup.sh" backup 2>/dev/null || true
done
