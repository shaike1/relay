#!/bin/bash
# Enhanced session-driver wrapper with optional tmate integration

SESSION_NAME="${1:-relay}"
WORKDIR="${2:-/root/relay}"
THREAD_ID="${3:-183}"

# Check if TMATE_DEBUG is set
if [ "$TMATE_DEBUG" = "1" ]; then
  echo "[tmate] Starting session-driver for $SESSION_NAME with live sharing..."
  exec tmate -F -n "relay-$SESSION_NAME" \
    python3 /root/relay/scripts/session-driver.py \
      --session "$SESSION_NAME" \
      --workdir "$WORKDIR" \
      --thread "$THREAD_ID"
else
  echo "[normal] Starting session-driver for $SESSION_NAME..."
  exec python3 /root/relay/scripts/session-driver.py \
    --session "$SESSION_NAME" \
    --workdir "$WORKDIR" \
    --thread "$THREAD_ID"
fi
