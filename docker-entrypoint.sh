#!/bin/bash
set -e

# Auto-update is opt-in. Newer Claude CLI builds do not support --yes,
# and trying to update on every boot adds noisy startup failures.
if [ "${CLAUDE_AUTO_UPDATE:-0}" = "1" ]; then
    echo "[entrypoint] Checking for Claude Code updates..."
    if claude update </dev/null >/dev/null 2>&1; then
        echo "[entrypoint] Claude Code updated."
    else
        echo "[entrypoint] Claude Code update skipped or failed."
    fi
else
    echo "[entrypoint] Claude auto-update disabled. Set CLAUDE_AUTO_UPDATE=1 to enable."
fi

exec python3 bot.py
