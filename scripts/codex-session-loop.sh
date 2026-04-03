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

    cat > "${SESSION_HOME}/.mcp.json" <<EOF
{
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
        "TELEGRAM_THREAD_ID": "${THREAD_ID}",
        "SESSION_NAME": "${SESSION}"
      }
    }
  }
}
EOF
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
        if "${CODEX_BIN}" resume --last \
            -c "${TRUST_CONFIG}" \
            --dangerously-bypass-approvals-and-sandbox \
            --no-alt-screen \
            -C "${SESSION_HOME}" \
            --add-dir /root; then
            :
        else
            "${CODEX_BIN}" \
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
