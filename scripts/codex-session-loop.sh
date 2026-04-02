#!/bin/bash
# codex-session-loop.sh <session_name> <work_dir>
# Run the Codex relay loop — shared session mode.
#
# For a "shared" codex session (SESSION_NAME=codex), messages can be prefixed
# with a project name to set the working directory:
#   "openclaw: check the latest PR"   → runs in /root/.openclaw/workspace
#   "relay: show sessions.json"        → runs in /root/relay
#   "check the code"                   → runs in WORKDIR (default)
#
# For dedicated sessions, the workdir is fixed.
set -euo pipefail

SESSION="${1:?session name required}"
WORKDIR="${2:?work dir required}"

CODEX_BIN="${CODEX_BIN:-$(which codex 2>/dev/null || echo "/root/.nvm/versions/node/v22.22.0/bin/codex")}"

# Use a per-session tmux socket (visible in hub.sh)
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"
export TMUX_SOCKET

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

tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }
log() { echo "[codex-session:${SESSION}] $*" >&2; }

QUEUE="/tmp/tg-queue-${THREAD_ID}.jsonl"
STATE_FILE="/tmp/codex-lastid-${SESSION}.state"

# Inner script that runs inside tmux
INNER_SCRIPT=$(mktemp /tmp/codex-inner-${SESSION}-XXXXXX.sh)
cat > "$INNER_SCRIPT" <<INNEREOF
#!/bin/bash
export IS_SANDBOX=1
export TELEGRAM_THREAD_ID="${THREAD_ID:-}"
export SESSION_NAME="${SESSION}"
CODEX_BIN="${CODEX_BIN}"
SESSION="${SESSION}"
QUEUE="${QUEUE}"
STATE_FILE="${STATE_FILE}"
DEFAULT_WORKDIR="${WORKDIR}"

log() { echo "[codex:\${SESSION_NAME}] \$*" >&2; }

# Load project paths from sessions.json for workdir routing
get_workdir() {
    local project="\$1"
    python3 -c "
import json
try:
    sessions = json.load(open('/root/relay/sessions.json'))
    s = next((s for s in sessions if s.get('session','').lower() == '\$project'.lower() and s.get('host') is None), None)
    print(s['path'] if s else '')
except Exception:
    print('')
" 2>/dev/null || echo ""
}

log "Codex shared session ready. Waiting for messages on thread ${THREAD_ID:-?}..."

# Show initial status in tmux
echo "╔══════════════════════════════════════════╗"
echo "║          CODEX SHARED SESSION            ║"
echo "╠══════════════════════════════════════════╣"
echo "║ Thread: ${THREAD_ID:-?}"
echo "║ Default workdir: ${WORKDIR}"
echo "║ Format: [project:] <task>"
echo "║ Example: relay: show sessions.json"
echo "╚══════════════════════════════════════════╝"
echo ""

last_id=0
[ -f "\$STATE_FILE" ] && last_id=\$(cat "\$STATE_FILE" 2>/dev/null || echo 0)

while true; do
    sleep 3

    [ -f "\$QUEUE" ] || continue

    # Get pending messages since last_id
    PENDING=\$(python3 -c "
import json, os
last_id = int(open('\$STATE_FILE').read().strip()) if os.path.exists('\$STATE_FILE') else 0
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
    new_last = max(m.get('message_id',0) for m in msgs)
    lines = [str(new_last)]
    for m in msgs:
        text = m.get('text','').strip()
        if text:
            lines.append(text)
    print('\n'.join(lines))
" 2>/dev/null || echo "")

    [ -z "\$PENDING" ] && continue

    NEW_LAST_ID=\$(echo "\$PENDING" | head -1)
    MESSAGES=\$(echo "\$PENDING" | tail -n +2)
    [ -z "\$MESSAGES" ] && { echo "\$NEW_LAST_ID" > "\$STATE_FILE"; continue; }

    # Process each message
    while IFS= read -r msg; do
        [ -z "\$msg" ] && continue
        log "Processing: \$msg"
        echo ""
        echo "[\$(date '+%H:%M:%S')] \$msg"
        echo "─────────────────────────────"

        # Check for project prefix: "projectname: task"
        TARGET_DIR="\$DEFAULT_WORKDIR"
        TASK="\$msg"
        if echo "\$msg" | grep -q "^[a-zA-Z_-]*:"; then
            prefix=\$(echo "\$msg" | cut -d: -f1 | tr -d ' ')
            task_part=\$(echo "\$msg" | cut -d: -f2- | sed 's/^ *//')
            proj_dir=\$(get_workdir "\$prefix")
            if [ -n "\$proj_dir" ] && [ -d "\$proj_dir" ]; then
                TARGET_DIR="\$proj_dir"
                TASK="\$task_part"
                echo "→ Project: \$prefix (\$TARGET_DIR)"
            fi
        fi

        cd "\$TARGET_DIR"
        FULL_PROMPT="Working directory: \$TARGET_DIR. Task: \$TASK"
        \$CODEX_BIN exec resume --last --dangerously-bypass-approvals-and-sandbox "\$FULL_PROMPT" 2>&1 \
            || \$CODEX_BIN exec --dangerously-bypass-approvals-and-sandbox "\$FULL_PROMPT" 2>&1 \
            || log "Codex failed for: \$TASK"
        cd "\$DEFAULT_WORKDIR"
    done <<< "\$MESSAGES"

    echo "\$NEW_LAST_ID" > "\$STATE_FILE"
done
INNEREOF
chmod +x "$INNER_SCRIPT"

if [ "${S6_SUPERVISED:-0}" = "1" ]; then
    tmux_s kill-server 2>/dev/null || true
    rm -f "$TMUX_SOCKET"
    tmux_s new-session -d -s "$SESSION" -c "$WORKDIR" "bash $INNER_SCRIPT"
    while tmux_s has-session -t "$SESSION" 2>/dev/null; do
        sleep 2
    done
    rm -f "$INNER_SCRIPT"
else
    bash "$INNER_SCRIPT"
    rm -f "$INNER_SCRIPT"
fi
