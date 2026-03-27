#!/bin/bash
# Auto-update Claude Code on all hosts when a new version is available
set -euo pipefail

source /root/relay/.env

RELAY_THREAD=183  # relay topic

tg_notify() {
    local msg="$1"
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${GROUP_CHAT_ID}" \
        -d message_thread_id="${RELAY_THREAD}" \
        -d parse_mode="HTML" \
        -d text="$msg" > /dev/null
}

LATEST=$(npm view @anthropic-ai/claude-code version 2>/dev/null)
if [[ -z "$LATEST" ]]; then
    echo "Could not fetch latest version from npm"
    exit 1
fi

UPDATED_HOSTS=()

# --- Local host ---
LOCAL_VER=$(npm list -g @anthropic-ai/claude-code 2>/dev/null | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1 || true)
if [[ -z "$LOCAL_VER" ]]; then
    LOCAL_VER=$(claude --version 2>/dev/null | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1 || true)
fi

if [[ -n "$LOCAL_VER" && "$LOCAL_VER" != "$LATEST" ]]; then
    echo "Local: $LOCAL_VER -> $LATEST"
    npm install -g "@anthropic-ai/claude-code@$LATEST" 2>&1
    UPDATED_HOSTS+=("$(hostname -s): $LOCAL_VER → $LATEST")
else
    echo "Local already at $LATEST"
fi

# --- Remote host ---
if [[ -n "${REMOTE_HOST:-}" ]]; then
    REMOTE_VER=$(ssh -o ConnectTimeout=10 "$REMOTE_HOST" \
        "claude --version 2>/dev/null | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1 || true" 2>/dev/null || true)

    if [[ -n "$REMOTE_VER" && "$REMOTE_VER" != "$LATEST" ]]; then
        echo "Remote $REMOTE_HOST: $REMOTE_VER -> $LATEST"
        ssh -o ConnectTimeout=10 "$REMOTE_HOST" \
            "npm install -g \"@anthropic-ai/claude-code@$LATEST\"" 2>&1
        UPDATED_HOSTS+=("$REMOTE_HOST: $REMOTE_VER → $LATEST")
    else
        echo "Remote $REMOTE_HOST already at $LATEST"
    fi
fi

# Notify Telegram if anything was updated
if [[ ${#UPDATED_HOSTS[@]} -gt 0 ]]; then
    MSG="<b>Claude Code עודכן לגירסה $LATEST</b>\n\n"
    for h in "${UPDATED_HOSTS[@]}"; do
        MSG+="• $h\n"
    done
    tg_notify "$MSG"
fi
