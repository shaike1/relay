#!/usr/bin/env bash
# upgrade.sh — Pre-backup, git pull, rebuild, and restart relay
# Sends Telegram notifications at start and end (or on error)
set -euo pipefail

RELAY_DIR="/root/relay"
SCRIPT_DIR="${RELAY_DIR}/scripts"

# Load env
ENV_FILE="${RELAY_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${GROUP_CHAT_ID:-}"
THREAD_ID="${ALERT_THREAD_ID:-}"
if [[ -z "$THREAD_ID" ]] && [[ -f "${RELAY_DIR}/sessions.json" ]]; then
  THREAD_ID=$(python3 -c "import json; s=json.load(open('${RELAY_DIR}/sessions.json')); print(s[0]['thread_id'])" 2>/dev/null || echo "")
fi

tg_notify() {
  local text="$1"
  if [[ -n "$BOT_TOKEN" && -n "$CHAT_ID" && -n "$THREAD_ID" ]]; then
    curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="${CHAT_ID}" \
      -d message_thread_id="${THREAD_ID}" \
      -d text="${text}" \
      -d parse_mode="HTML" \
      --max-time 10 > /dev/null 2>&1 || true
  fi
}

fail() {
  local msg="$1"
  echo "[upgrade] ERROR: $msg"
  tg_notify "❌ שדרוג נכשל: ${msg}"
  exit 1
}

tg_notify "🚀 מתחיל שדרוג relay — גיבוי ראשון..."
echo "[upgrade] Starting upgrade at $(date)"

# Step 1: Backup first
echo "[upgrade] Step 1: Running backup..."
bash "${SCRIPT_DIR}/backup.sh" || fail "backup.sh failed"

# Step 2: Git pull
echo "[upgrade] Step 2: git pull..."
cd "$RELAY_DIR"
git pull || fail "git pull failed"

# Step 3: Build main compose
echo "[upgrade] Step 3: docker compose build..."
docker compose build || fail "docker compose build failed"

# Step 4: Restart main services
echo "[upgrade] Step 4: docker compose up -d..."
docker compose up -d || fail "docker compose up -d failed"

# Step 5: Restart session containers
echo "[upgrade] Step 5: docker compose sessions up -d..."
if [[ -f "${RELAY_DIR}/docker-compose.sessions.yml" ]]; then
  docker compose -f docker-compose.sessions.yml up -d || fail "sessions compose up failed"
fi

echo "[upgrade] Upgrade complete at $(date)"
tg_notify "✅ שדרוג relay הושלם בהצלחה"
