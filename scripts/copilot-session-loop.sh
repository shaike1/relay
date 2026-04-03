#!/bin/bash
# copilot-session-loop.sh <session_name> <work_dir>
# Run the GitHub Copilot CLI relay loop for one session.
# Like claude-session-loop.sh but launches `gh copilot` instead of `claude`.
set -euo pipefail

SESSION="${1:?session name required}"
WORKDIR="${2:?work dir required}"

# Per-session tmux socket on the shared /tmp volume
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"
export TMUX_SOCKET

cd "$WORKDIR"

# Source .env for Telegram credentials (not set in container env by default)
if [ -f /root/relay/.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /root/relay/.env
  set +a
fi

# Helper: run tmux with this session's socket
tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }

# Get thread_id from sessions.json for MCP wiring
THREAD_ID=$(python3 -c "
import json
try:
    sessions = json.load(open('/root/relay/sessions.json'))
    s = next((s for s in sessions if s['session'] == '$SESSION'), None)
    print(s['thread_id'] if s else '')
except Exception:
    print('')
")

if [ -n "$THREAD_ID" ]; then
  export TELEGRAM_THREAD_ID="$THREAD_ID"
  export SESSION_NAME="$SESSION"
fi

# Build MCP config JSON for the telegram server
# Uses the same mcp-telegram/server.ts that Claude sessions use
# Inject telegram MCP server into copilot's mcp-config.json
COPILOT_MCP_CONFIG="/root/.copilot/mcp-config.json"
python3 -c "
import json, os
config_path = '$COPILOT_MCP_CONFIG'
try:
    config = json.load(open(config_path))
except Exception:
    config = {'mcpServers': {}}
config['mcpServers']['telegram'] = {
    'type': 'local',
    'command': '/root/.bun/bin/bun',
    'args': ['run', '--cwd', '/root/relay/mcp-telegram', 'server.ts'],
    'tools': ['*'],
    'env': {
        'TELEGRAM_BOT_TOKEN': os.environ.get('TELEGRAM_BOT_TOKEN', ''),
        'GROUP_CHAT_ID': os.environ.get('GROUP_CHAT_ID', ''),
        'TELEGRAM_THREAD_ID': os.environ.get('TELEGRAM_THREAD_ID', ''),
        'SESSION_NAME': os.environ.get('SESSION_NAME', ''),
        'OWNER_ID': os.environ.get('OWNER_ID', '')
    }
}
with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
"

# Inner loop script that runs inside tmux
INNER_SCRIPT=$(mktemp /tmp/copilot-inner-${SESSION}-XXXXXX.sh)
cat > "$INNER_SCRIPT" <<INNER
#!/bin/bash
set -euo pipefail
export TELEGRAM_THREAD_ID="${TELEGRAM_THREAD_ID:-}"
export SESSION_NAME="${SESSION}"
cd "$WORKDIR"

while true; do
  # Try to resume last session, fall back to new session
  gh copilot -- \\
    --yolo \\
    --continue \\
    2>/dev/null \\
  || gh copilot -- \\
    --yolo \\
    2>/dev/null \\
  || true

  sleep 1
done
INNER
chmod +x "$INNER_SCRIPT"

if [ "${S6_SUPERVISED:-0}" = "1" ]; then
  # Container mode: run Copilot inside an isolated tmux session.
  tmux_s kill-server 2>/dev/null || true
  rm -f "$TMUX_SOCKET"

  tmux_s new-session -d -s "$SESSION" -c "$WORKDIR" "bash $INNER_SCRIPT"

  # Wait for the tmux session to exit, then s6 will restart.
  while tmux_s has-session -t "$SESSION" 2>/dev/null; do
    sleep 2
  done

  rm -f "$INNER_SCRIPT"
else
  # Non-container mode: run directly
  rm -f "$INNER_SCRIPT"

  while true; do
    gh copilot -- \
      --yolo \
      --continue \
      2>/dev/null \
    || gh copilot -- \
      --yolo \
      2>/dev/null \
    || true

    sleep 1
  done
fi
