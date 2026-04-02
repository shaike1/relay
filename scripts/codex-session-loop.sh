#!/bin/bash
# codex-session-loop.sh <session_name> <work_dir>
# Run the Codex relay loop for one session.
# Unlike Claude (which uses --remote-control + tmux send-keys),
# Codex uses a stdin-pipe approach: messages are fed via a named pipe
# into `codex exec resume --last` which processes them and exits.
# The outer loop keeps the service alive and picks up new messages.
set -euo pipefail

SESSION="${1:?session name required}"
WORKDIR="${2:?work dir required}"

CODEX_BIN="${CODEX_BIN:-$(which codex 2>/dev/null || echo "/root/.nvm/versions/node/v22.22.0/bin/codex")}"
CODEX_ARGS="${CODEX_ARGS:---dangerously-bypass-approvals-and-sandbox}"

# Use a per-session tmux socket (consistent with Claude sessions for hub.sh attach)
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"
export TMUX_SOCKET

# Named pipe for feeding messages into codex
PIPE="/tmp/codex-input-${SESSION}.pipe"
QUEUE_STATE="/tmp/tg-queue-state-${SESSION}"

export IS_SANDBOX=1

# Get thread_id for this session
THREAD_ID=$(python3 -c "
import json
try:
    sessions = json.load(open('/root/relay/sessions.json'))
    s = next((s for s in sessions if s['session'] == '$SESSION'), None)
    print(s['thread_id'] if s else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

cd "$WORKDIR"

# Helper: run tmux with this session's socket
tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }

log() { echo "[codex-session:${SESSION}] $*" >&2; }

# Inner script that runs Codex inside tmux
INNER_SCRIPT=$(mktemp /tmp/codex-inner-${SESSION}-XXXXXX.sh)
cat > "$INNER_SCRIPT" <<INNEREOF
#!/bin/bash
set -euo pipefail
export IS_SANDBOX=1
export TELEGRAM_THREAD_ID="${THREAD_ID:-}"
export SESSION_NAME="${SESSION}"
CODEX_BIN="${CODEX_BIN}"
CODEX_ARGS="${CODEX_ARGS}"
QUEUE="/tmp/tg-queue-${THREAD_ID:-0}.jsonl"
STATE_FILE="/tmp/codex-lastid-${SESSION}.state"
PIPE="/tmp/codex-input-${SESSION}.pipe"

# Create named pipe if missing
[ -p "\$PIPE" ] || mkfifo "\$PIPE"

cd "$WORKDIR"

# Start Codex in headless mode — first run without resume
log() { echo "[codex:\${SESSION_NAME}] \$*" >&2; }

log "Starting Codex session..."

# Initial startup message
INIT_MSG="You are an AI assistant in the Relay system. Session: ${SESSION}. Working directory: ${WORKDIR}. Your Telegram thread ID is ${THREAD_ID:-none}. Wait for messages via fetch_messages and respond via send_message."

\$CODEX_BIN exec \$CODEX_ARGS "\$INIT_MSG" 2>&1 || true

# Main loop: poll queue and run codex for each new message
last_id=0
[ -f "\$STATE_FILE" ] && last_id=\$(cat "\$STATE_FILE" 2>/dev/null || echo 0)

while true; do
    sleep 3

    [ -f "\$QUEUE" ] || continue

    # Get pending messages since last_id
    MESSAGES=\$(python3 -c "
import json
last_id = int(open('$STATE_FILE').read().strip()) if __import__('os').path.exists('$STATE_FILE') else 0
msgs = []
with open('\$QUEUE') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            m = json.loads(line)
            mid = m.get('message_id', 0)
            if mid > last_id:
                msgs.append(m)
        except: pass
if msgs:
    last_id = max(m.get('message_id',0) for m in msgs)
    print(last_id)
    for m in msgs:
        sender = m.get('sender', 'User')
        text = m.get('text', '')
        print(f'[{sender}]: {text}')
" 2>/dev/null || echo "")

    [ -z "\$MESSAGES" ] && continue

    NEW_LAST_ID=\$(echo "\$MESSAGES" | head -1)
    PROMPT=\$(echo "\$MESSAGES" | tail -n +2 | tr '\n' ' ')

    [ -z "\$PROMPT" ] && continue

    log "Processing \$(echo "\$MESSAGES" | tail -n +2 | wc -l) message(s)..."

    # Run codex with the new messages, resuming last session
    FULL_PROMPT="You have pending Telegram messages. Process them and respond via send_message. Messages: \$PROMPT"
    \$CODEX_BIN exec resume --last \$CODEX_ARGS "\$FULL_PROMPT" 2>&1 || \
        \$CODEX_BIN exec \$CODEX_ARGS "\$FULL_PROMPT" 2>&1 || true

    # Update last seen ID
    echo "\$NEW_LAST_ID" > "\$STATE_FILE"
done
INNEREOF
chmod +x "$INNER_SCRIPT"

if [ "${S6_SUPERVISED:-0}" = "1" ]; then
    # Container mode: run inside tmux for hub.sh visibility
    tmux_s kill-server 2>/dev/null || true
    rm -f "$TMUX_SOCKET"

    tmux_s new-session -d -s "$SESSION" -c "$WORKDIR" "bash $INNER_SCRIPT"

    while tmux_s has-session -t "$SESSION" 2>/dev/null; do
        sleep 2
    done

    rm -f "$INNER_SCRIPT"
else
    # Non-container mode: run directly
    bash "$INNER_SCRIPT"
    rm -f "$INNER_SCRIPT"
fi
