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

exec /usr/bin/python3 "$RELAY_DIR/bot.py"
