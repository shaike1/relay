#!/bin/bash
# mcp-server-wrapper.sh — supervises the bun MCP server
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:?TELEGRAM_THREAD_ID required}"
SESSION="${SESSION_NAME:?SESSION_NAME required}"

cleanup() {
  rm -f "/tmp/tg-queue-${THREAD_ID}.lock"
}

while true; do
  cleanup
  echo "[mcp-wrapper:${SESSION}] Starting MCP server (thread=${THREAD_ID})" >&2
  /root/.bun/bin/bun run --cwd /root/relay/mcp-telegram --silent start || true
  echo "[mcp-wrapper:${SESSION}] MCP server exited — restarting in 2s" >&2
  sleep 2
done
