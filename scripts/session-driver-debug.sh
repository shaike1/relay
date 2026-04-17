#!/bin/bash
# Wrapper to run session-driver with tmate for live debugging

SESSION_NAME="${1:-relay}"
WORKDIR="${2:-/root/relay}"
THREAD_ID="${3:-183}"

echo "Starting session-driver for $SESSION_NAME with tmate..."
echo "Wait for share links..."
echo ""

# Start tmate session with session-driver
tmate -F -n "relay-$SESSION_NAME" \
  python3 /root/relay/scripts/session-driver.py \
    --session "$SESSION_NAME" \
    --workdir "$WORKDIR" \
    --thread "$THREAD_ID"
