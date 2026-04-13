#!/bin/bash
# mcp-server-wrapper.sh — supervises the bun MCP server
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:?TELEGRAM_THREAD_ID required}"
SESSION="${SESSION_NAME:?SESSION_NAME required}"

WRAPPER_LOCK="/tmp/mcp-wrapper-${THREAD_ID}.lock"
exec 9>"$WRAPPER_LOCK"
if ! flock -n 9; then
  echo "[mcp-wrapper:${SESSION}] Another wrapper already active for thread=${THREAD_ID}; exiting" >&2
  exit 0
fi

echo $$ 1>&9 || true

while true; do
  echo "[mcp-wrapper:${SESSION}] Starting MCP server (thread=${THREAD_ID})" >&2
  /root/.bun/bin/bun run --cwd /root/relay/mcp-telegram --silent start || true
  echo "[mcp-wrapper:${SESSION}] MCP server exited — restarting in 2s" >&2
  sleep 2
done
