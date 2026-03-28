#!/bin/bash
set -e

# Auto-update Claude Code on every container start
echo "[entrypoint] Checking for Claude Code updates..."
if claude update --yes 2>/dev/null; then
    echo "[entrypoint] Claude Code updated."
else
    echo "[entrypoint] Claude Code is up to date (or update skipped)."
fi

exec python3 bot.py
