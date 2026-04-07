#!/bin/bash
# codex-session-loop.sh <session_name> <default_work_dir>
# Run a persistent interactive Codex relay session inside tmux.
#
# Unlike the old shared-session wrapper, this keeps one long-lived Codex TUI
# alive and relies on the Telegram MCP server plus message-watchdog nudges.
set -euo pipefail

SESSION="${1:?session name required}"
DEFAULT_WORKDIR="${2:?default work dir required}"

CODEX_BIN="${CODEX_BIN:-$(which codex 2>/dev/null || echo "/root/.nvm/versions/node/v22.22.0/bin/codex")}"
TMUX_SOCKET="/tmp/tmux-${SESSION}.sock"
SESSION_HOME_BASE="${CODEX_SESSION_HOME_BASE:-/root/.relay-codex}"
SESSION_HOME="${SESSION_HOME_BASE}/${SESSION}"
TRUST_CONFIG="projects.\"${SESSION_HOME}\".trust_level=\"trusted\""

export IS_SANDBOX=1
export TMUX_SOCKET

THREAD_ID="$(python3 - "$SESSION" <<'PY'
import json
import sys

session = sys.argv[1]
try:
    with open('/root/relay/sessions.json') as fh:
        sessions = json.load(fh)
except Exception:
    print('')
    raise SystemExit(0)

match = next((s for s in sessions if s.get('session') == session), None)
print(match.get('thread_id', '') if match else '')
PY
)"

log() { echo "[codex-session:${SESSION}] $*" >&2; }
tmux_s() { tmux -S "$TMUX_SOCKET" "$@"; }

write_session_mcp_config() {
    [ -n "${THREAD_ID:-}" ] || return 0

    # Read per-session bot_token from sessions.json (falls back to default)
    local BOT_TOKEN_OVERRIDE
    BOT_TOKEN_OVERRIDE="$(python3 - "$SESSION" <<'PYBT'
import json, sys
session = sys.argv[1]
try:
    sessions = json.load(open('/root/relay/sessions.json'))
    s = next((s for s in sessions if s.get('session') == session), None)
    print(s.get('bot_token', '') if s else '')
except Exception:
    print('')
PYBT
)"

    # Build env block — include bot_token override if set
    local env_block
    if [ -n "$BOT_TOKEN_OVERRIDE" ]; then
        env_block='"TELEGRAM_THREAD_ID": "'"${THREAD_ID}"'", "SESSION_NAME": "'"${SESSION}"'", "TELEGRAM_BOT_TOKEN": "'"${BOT_TOKEN_OVERRIDE}"'"'
    else
        env_block='"TELEGRAM_THREAD_ID": "'"${THREAD_ID}"'", "SESSION_NAME": "'"${SESSION}"'"'
    fi

    local mcp_json='{
  "mcpServers": {
    "telegram": {
      "command": "/root/.bun/bin/bun",
      "args": [
        "run",
        "--cwd",
        "/root/relay/mcp-telegram",
        "server.ts"
      ],
      "env": {
        '"${env_block}"'
      }
    }
  }
}'
    echo "$mcp_json" > "${SESSION_HOME}/.mcp.json"

    # Also inject telegram into /root/.codex/mcp.json (legacy JSON config)
    local bt_env=""
    [ -n "$BOT_TOKEN_OVERRIDE" ] && bt_env=", 'TELEGRAM_BOT_TOKEN': '${BOT_TOKEN_OVERRIDE}'"
    if [ -f /root/.codex/mcp.json ]; then
        python3 -c "
import json
p = '/root/.codex/mcp.json'
d = json.load(open(p))
d['mcpServers']['telegram'] = {
    'type': 'stdio',
    'command': '/root/.bun/bin/bun',
    'args': ['run', '--cwd', '/root/relay/mcp-telegram', 'server.ts'],
    'env': {'TELEGRAM_THREAD_ID': '${THREAD_ID}', 'SESSION_NAME': '${SESSION}'${bt_env}}
}
json.dump(d, open(p, 'w'), indent=2)
" 2>/dev/null || true
    fi

    # Update /root/.codex/config.toml — the actual Codex CLI MCP config (TOML format)
    if [ -f /root/.codex/config.toml ]; then
        python3 -c "
import re, sys

path = '/root/.codex/config.toml'
content = open(path).read()

thread_id = '${THREAD_ID}'
session = '${SESSION}'
bot_token = '${BOT_TOKEN_OVERRIDE}'

if bot_token:
    env_line = 'env = { TELEGRAM_THREAD_ID = \"' + thread_id + '\", SESSION_NAME = \"' + session + '\", TELEGRAM_BOT_TOKEN = \"' + bot_token + '\" }'
else:
    env_line = 'env = { TELEGRAM_THREAD_ID = \"' + thread_id + '\", SESSION_NAME = \"' + session + '\" }'

# Replace existing env line under [mcp_servers.telegram]
content = re.sub(
    r'(\[mcp_servers\.telegram\].*?env\s*=\s*\{[^\}]*\})',
    lambda m: re.sub(r'env\s*=\s*\{[^\}]*\}', env_line, m.group(0)),
    content,
    flags=re.DOTALL
)
open(path, 'w').write(content)
" 2>/dev/null || true
    fi
}

write_session_agents() {
    cat > "${SESSION_HOME}/AGENTS.md" <<EOF
# Codex Telegram Relay

You are running in the shared Codex Telegram session. The human user does not
see terminal output. Reply through the Telegram MCP server, not by writing
answers only in the terminal.

## Message handling

For every user request that arrives through Telegram:

1. Call \`typing\` quickly.
2. Do the work.
3. Reply with \`send_message\`.

If you need to see pending or recent topic messages, call \`fetch_messages\`.
Do not leave Telegram messages unanswered.

## Shared topic routing

This session is a shared topic and supports project tags in the user's message:

- \`@session-name task\`
- \`[session-name] task\`
- \`session-name: task\`

When a tag is present:

1. Read \`/root/relay/sessions.json\`.
2. Resolve the matching \`session\`, \`path\`, and optional \`host\`.
3. If \`host\` is empty, do the work against the local \`path\`.
4. If \`host\` is set, use SSH to inspect or operate on that remote host.
5. Report results back with \`send_message\`.

If no tag is present, treat \`${DEFAULT_WORKDIR}\` as the default local context.

## Working rules

- Keep replies concise and readable for Telegram.
- Summarize command output instead of dumping raw terminal noise unless the user
  explicitly asks for full output.
- Prefer absolute paths when describing file changes.
- If a task is long-running, send a short progress update with \`send_message\`.
- If MCP tools are unavailable or failing, explain that via \`send_message\`.
EOF
}

ensure_session_home() {
    mkdir -p "${SESSION_HOME}"
    write_session_mcp_config
    write_session_agents
}

run_codex_forever() {
    cd "${SESSION_HOME}"

    while true; do
        # Overwrite telegram in /root/.mcp.json with the correct thread_id
        # for this codex session. bot.py may set it to thread 213 (main) but
        # we need 8542 (codex). Claude Code reads .mcp.json from workdir /root.
        write_session_mcp_config
        python3 -c "
import json, sys
p = '/root/.mcp.json'
thread_id = '${THREAD_ID}'
session = '${SESSION}'
bot_token = '${BOT_TOKEN_OVERRIDE}'
try:
    d = json.load(open(p))
except: d = {'mcpServers': {}}
env = {'TELEGRAM_THREAD_ID': thread_id, 'SESSION_NAME': session}
if bot_token:
    env['TELEGRAM_BOT_TOKEN'] = bot_token
d.setdefault('mcpServers', {})['telegram'] = {
    'command': '/root/.bun/bin/bun',
    'args': ['run', '--cwd', '/root/relay/mcp-telegram', 'server.ts'],
    'env': env
}
json.dump(d, open(p, 'w'), indent=2)
" 2>/dev/null || true

        if "${CODEX_BIN}" resume --last \
            --yolo \
            -c "${TRUST_CONFIG}" \
            --dangerously-bypass-approvals-and-sandbox \
            --no-alt-screen \
            -C "${SESSION_HOME}" \
            --add-dir /root; then
            :
        else
            "${CODEX_BIN}" \
                --yolo \
                -c "${TRUST_CONFIG}" \
                --dangerously-bypass-approvals-and-sandbox \
                --no-alt-screen \
                -C "${SESSION_HOME}" \
                --add-dir /root \
                "You are the shared Codex Telegram relay session. Read the local AGENTS.md, use the telegram MCP tools for user-visible replies, and wait for incoming work."
        fi

        log "Codex exited; restarting in 1s"
        sleep 1
    done
}

ensure_session_home

if [ "${3:-}" = "--inner" ]; then
    run_codex_forever
elif [ "${S6_SUPERVISED:-0}" = "1" ]; then
    while true; do
        tmux_s kill-server 2>/dev/null || true
        rm -f "${TMUX_SOCKET}"
        tmux_s new-session -d -s "${SESSION}" -c "${SESSION_HOME}" "bash /relay/scripts/codex-session-loop.sh ${SESSION@Q} ${DEFAULT_WORKDIR@Q} --inner"

        while tmux_s has-session -t "${SESSION}" 2>/dev/null; do
            sleep 2
        done

        log "tmux session '${SESSION}' exited; restarting shared Codex loop"
        sleep 1
    done
else
    run_codex_forever
fi
