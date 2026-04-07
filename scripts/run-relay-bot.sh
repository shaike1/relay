#!/bin/bash
set -euo pipefail

RELAY_DIR="${RELAY_DIR:-/root/relay}"
ENV_FILE="${RELAY_ENV_FILE:-$RELAY_DIR/.env}"

cd "$RELAY_DIR"

if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

# Start weekly docker prune background loop if not already running
if ! pgrep -f "docker-prune-loop.sh" > /dev/null 2>&1; then
    nohup "$RELAY_DIR/scripts/docker-prune-loop.sh" > /dev/null 2>&1 &
fi

exec /usr/bin/python3 "$RELAY_DIR/bot.py"
