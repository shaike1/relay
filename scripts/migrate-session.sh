#!/usr/bin/env bash
# migrate-session.sh — Migrate a session to a new host
# Usage: migrate-session.sh <session_name> <user@new-host>
set -euo pipefail

RELAY_DIR="/root/relay"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <session_name> <user@new-host>"
  echo "Example: $0 relay root@10.0.0.5"
  exit 1
fi

SESSION_NAME="$1"
REMOTE_HOST="$2"

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
  echo "[migrate] ERROR: $msg"
  tg_notify "❌ Migration נכשל: ${msg}"
  exit 1
}

# Read session config from sessions.json
SESSION_JSON=$(python3 -c "
import json, sys
sessions = json.load(open('${RELAY_DIR}/sessions.json'))
s = next((x for x in sessions if x.get('session') == '${SESSION_NAME}'), None)
if not s:
    print('NOT_FOUND')
    sys.exit(1)
print(json.dumps(s))
" 2>/dev/null) || fail "Session '${SESSION_NAME}' not found in sessions.json"

if [[ "$SESSION_JSON" == "NOT_FOUND" ]]; then
  fail "Session '${SESSION_NAME}' not found in sessions.json"
fi

SESSION_PATH=$(python3 -c "import json,sys; s=json.loads('${SESSION_JSON}'.replace(\"'\", '\"')); print(s.get('path','/root'))" 2>/dev/null || echo "/root")
THREAD_ID_SESSION=$(python3 -c "import json; s=json.loads('''${SESSION_JSON}'''); print(s.get('thread_id',''))" 2>/dev/null || echo "")

echo "[migrate] Migrating session '${SESSION_NAME}' to ${REMOTE_HOST}"
echo "[migrate] Session path: ${SESSION_PATH}"
tg_notify "🚚 מתחיל migration של <code>${SESSION_NAME}</code> ל-<code>${REMOTE_HOST}</code>"

# Step 1: Clone relay repo on remote host
REPO_URL=$(git -C "$RELAY_DIR" remote get-url origin 2>/dev/null || echo "")
if [[ -n "$REPO_URL" ]]; then
  echo "[migrate] Cloning relay repo on remote..."
  ssh "$REMOTE_HOST" "
    if [[ ! -d /root/relay ]]; then
      git clone '${REPO_URL}' /root/relay
    else
      echo 'relay dir already exists, skipping clone'
    fi
  " || echo "[migrate] Warning: remote git clone failed (may already exist)"
fi

# Step 2: Copy .env to remote
echo "[migrate] Copying .env to remote..."
scp "${RELAY_DIR}/.env" "${REMOTE_HOST}:/root/relay/.env" || fail "scp .env failed"

# Step 3: Copy sessions.json to remote
echo "[migrate] Copying sessions.json to remote..."
scp "${RELAY_DIR}/sessions.json" "${REMOTE_HOST}:/root/relay/sessions.json" || echo "[migrate] Warning: sessions.json copy failed"

# Step 4: Update sessions.json locally to set host field for this session
echo "[migrate] Updating sessions.json host field for ${SESSION_NAME}..."
python3 - <<PYEOF
import json

sessions_file = '${RELAY_DIR}/sessions.json'
sessions = json.load(open(sessions_file))
for s in sessions:
    if s.get('session') == '${SESSION_NAME}':
        s['host'] = '${REMOTE_HOST}'
        print(f"[migrate] Updated host for {s['session']} -> ${REMOTE_HOST}")
        break

with open(sessions_file, 'w') as f:
    json.dump(sessions, f, indent=2)
print('[migrate] sessions.json updated')
PYEOF

echo "[migrate] Migration complete for '${SESSION_NAME}' -> ${REMOTE_HOST}"
tg_notify "✅ Migration הושלם: <code>${SESSION_NAME}</code> → <code>${REMOTE_HOST}</code>"
