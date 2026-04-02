#!/bin/bash
# codex-session-loop.sh <session_name> <work_dir>
# Run the Codex relay loop — shared session mode.
#
# For a "shared" codex session (SESSION_NAME=codex), messages can be tagged
# with a project/session name to choose where Codex runs:
#   "openclaw: check the latest PR"   → runs on the host for session "openclaw"
#   "@relay show sessions.json"       → runs in /root/relay
#   "[teamy] inspect docker logs"     → runs on the remote host for "teamy"
#   "check the code"                  → runs in WORKDIR (default)
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

# Resolve a tagged session from sessions.json.
# Output: session<TAB>path<TAB>host
resolve_target() {
    local project="\$1"
    python3 -c "
import json
import re

def normalize(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '', value.lower())

try:
    sessions = json.load(open('/root/relay/sessions.json'))
    raw = '\$project'.strip()
    normalized = normalize(raw)

    exact = next((s for s in sessions if s.get('session', '').lower() == raw.lower()), None)
    if exact:
        print(f\"{exact['session']}\t{exact['path']}\t{exact.get('host') or ''}\")
    else:
        normalized_matches = [s for s in sessions if normalize(s.get('session', '')) == normalized]
        if len(normalized_matches) == 1:
            match = normalized_matches[0]
            print(f\"{match['session']}\t{match['path']}\t{match.get('host') or ''}\")
except Exception:
    print('')
" 2>/dev/null || echo ""
}

strip_sender_prefix() {
    local msg="\$1"
    if [[ "\$msg" =~ ^\[[^]]+\]:[[:space:]]*(.*)$ ]]; then
        printf '%s\n' "\${BASH_REMATCH[1]}"
    else
        printf '%s\n' "\$msg"
    fi
}

print_help() {
    echo "Codex shared topic routes by session tag."
    echo "Formats:"
    echo "  relay: show sessions.json"
    echo "  @openclaw inspect recent commits"
    echo "  [teamy] review docker status"
    echo "  plain message -> default workdir (${WORKDIR})"
    echo "Use 'projects' to list available tags."
}

print_projects() {
    python3 -c "
import json
try:
    sessions = json.load(open('/root/relay/sessions.json'))
    for s in sessions:
        name = s.get('session', '')
        host = s.get('host') or 'local'
        if name and name != 'codex':
            print(f'- {name} ({host})')
except Exception as exc:
    print(f'Unable to list projects: {exc}')
" 2>/dev/null || echo "Unable to list projects."
}

run_codex_local() {
    local target_dir="\$1"
    local prompt="\$2"
    cd "\$target_dir"
    "\$CODEX_BIN" exec resume --last --dangerously-bypass-approvals-and-sandbox "\$prompt" 2>&1 \
        || "\$CODEX_BIN" exec --dangerously-bypass-approvals-and-sandbox "\$prompt" 2>&1
    cd "\$DEFAULT_WORKDIR"
}

run_codex_remote() {
    local remote_host="\$1"
    local target_dir="\$2"
    local prompt="\$3"
    local q_dir q_prompt
    q_dir=\$(printf '%q' "\$target_dir")
    q_prompt=\$(printf '%q' "\$prompt")

    ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no "\$remote_host" \
        "cd \$q_dir && if [ ! -x /root/.nvm/versions/node/v22.22.0/bin/codex ]; then REMOTE_CODEX_BIN=codex; else REMOTE_CODEX_BIN=/root/.nvm/versions/node/v22.22.0/bin/codex; fi; \"\\\$REMOTE_CODEX_BIN\" exec resume --last --dangerously-bypass-approvals-and-sandbox \$q_prompt 2>&1 || \"\\\$REMOTE_CODEX_BIN\" exec --dangerously-bypass-approvals-and-sandbox \$q_prompt 2>&1"
}

log "Codex shared session ready. Waiting for messages on thread ${THREAD_ID:-?}..."

# Show initial status in tmux
echo "╔══════════════════════════════════════════╗"
echo "║          CODEX SHARED SESSION            ║"
echo "╠══════════════════════════════════════════╣"
echo "║ Thread: ${THREAD_ID:-?}"
echo "║ Default workdir: ${WORKDIR}"
echo "║ Tags: project: task | @project task"
echo "║       [project] task | plain message"
echo "║ Helpers: help | projects"
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

        CLEAN_MSG=\$(strip_sender_prefix "\$msg")
        TARGET_SESSION=""
        TARGET_DIR="\$DEFAULT_WORKDIR"
        TARGET_HOST=""
        TASK="\$CLEAN_MSG"

        lower_msg=\$(printf '%s' "\$CLEAN_MSG" | tr '[:upper:]' '[:lower:]')
        if [ "\$lower_msg" = "help" ] || [ "\$lower_msg" = "/help" ]; then
            print_help
            continue
        fi
        if [ "\$lower_msg" = "projects" ] || [ "\$lower_msg" = "/projects" ] || [ "\$lower_msg" = "list projects" ]; then
            print_projects
            continue
        fi

        prefix=""
        task_part=""
        if [[ "\$CLEAN_MSG" =~ ^@([A-Za-z0-9._-]+)[[:space:]]+(.+)$ ]]; then
            prefix="\${BASH_REMATCH[1]}"
            task_part="\${BASH_REMATCH[2]}"
        elif [[ "\$CLEAN_MSG" =~ ^\[([A-Za-z0-9._ -]+)\][[:space:]]*(.+)$ ]]; then
            prefix="\${BASH_REMATCH[1]}"
            task_part="\${BASH_REMATCH[2]}"
        elif [[ "\$CLEAN_MSG" =~ ^([A-Za-z0-9._ -]+):[[:space:]]*(.+)$ ]]; then
            prefix="\${BASH_REMATCH[1]}"
            task_part="\${BASH_REMATCH[2]}"
        fi

        if [ -n "\$prefix" ]; then
            prefix=\$(echo "\$prefix" | sed 's/^ *//; s/ *$//')
            resolved=\$(resolve_target "\$prefix")
            if [ -n "\$resolved" ]; then
                TARGET_SESSION=\$(printf '%s' "\$resolved" | cut -f1)
                TARGET_DIR=\$(printf '%s' "\$resolved" | cut -f2)
                TARGET_HOST=\$(printf '%s' "\$resolved" | cut -f3)
                TASK="\$task_part"
                echo "→ Session: \$TARGET_SESSION (\${TARGET_HOST:-local})"
                echo "→ Workdir: \$TARGET_DIR"
            else
                echo "Unknown project tag: \$prefix"
                echo "Send 'projects' to list available tags."
                continue
            fi
        fi

        FULL_PROMPT="Working directory: \$TARGET_DIR. Task: \$TASK"
        if [ -n "\$TARGET_HOST" ]; then
            run_codex_remote "\$TARGET_HOST" "\$TARGET_DIR" "\$FULL_PROMPT" \
                || log "Remote Codex failed for: \$TASK"
        else
            run_codex_local "\$TARGET_DIR" "\$FULL_PROMPT" \
                || log "Codex failed for: \$TASK"
        fi
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
