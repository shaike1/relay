#!/bin/bash
# session-run.sh — run a command in a session's project dir, then restart Claude
#
# Usage:
#   ./session-run.sh <session-name> [command...]
#   ./session-run.sh <session-name> --mcp <mcp-name> <binary> [arg...] [KEY=VALUE...]
#
# --mcp flag: resolves binary full path on the target host automatically,
#   then runs: claude mcp add-json <mcp-name> {...} -s local
#   Useful for npm/nvm binaries that aren't in Claude's minimal PATH.
#
# Examples:
#   ./session-run.sh edushare                          # just restart
#   ./session-run.sh edushare --mcp stitch stitch-mcp proxy STITCH_API_KEY=abc123
#   ./session-run.sh edushare claude mcp remove stitch -s local
#
# Looks up host and path from sessions.json automatically.

set -euo pipefail

SESSIONS_FILE="$(dirname "$0")/sessions.json"

SESSION="${1:-}"
if [[ -z "$SESSION" ]]; then
  echo "Usage: $0 <session-name> [--mcp <name> <binary> [args...] [KEY=VAL...]] [command...]"
  exit 1
fi
shift

# Look up session config
HOST=$(jq -r --arg s "$SESSION" '.[] | select(.session==$s) | .host // ""' "$SESSIONS_FILE")
PATH_=$(jq -r --arg s "$SESSION" '.[] | select(.session==$s) | .path' "$SESSIONS_FILE")

if [[ -z "$PATH_" ]]; then
  echo "Session '$SESSION' not found in sessions.json"
  exit 1
fi

echo "Session: $SESSION | Host: ${HOST:-local} | Path: $PATH_"

run_remote() {
  if [[ -n "$HOST" ]]; then
    ssh -o StrictHostKeyChecking=no "$HOST" "$1"
  else
    bash -c "$1"
  fi
}

# --mcp flag: resolve full binary path and add MCP with claude mcp add-json
if [[ "${1:-}" == "--mcp" ]]; then
  shift
  MCP_NAME="${1:?--mcp requires: <name> <binary> [args...] [KEY=VAL...]}"; shift
  MCP_BIN="${1:?--mcp requires a binary name}"; shift

  # Separate remaining args from KEY=VALUE env pairs
  MCP_ARGS=()
  MCP_ENV="{}"
  ENV_PAIRS=()
  for arg in "$@"; do
    if [[ "$arg" == *=* ]]; then
      ENV_PAIRS+=("$arg")
    else
      MCP_ARGS+=("$arg")
    fi
  done

  # Build env JSON
  if [[ ${#ENV_PAIRS[@]} -gt 0 ]]; then
    ENV_JSON="{"
    for pair in "${ENV_PAIRS[@]}"; do
      key="${pair%%=*}"
      val="${pair#*=}"
      ENV_JSON+="\"$key\":\"$val\","
    done
    ENV_JSON="${ENV_JSON%,}}"
    MCP_ENV="$ENV_JSON"
  fi

  # Resolve full binary path on target host
  echo "Resolving path for '$MCP_BIN' on ${HOST:-local}..."
  FULL_BIN=$(run_remote "which '$MCP_BIN' 2>/dev/null || find /root/.nvm /usr/local/bin -name '$MCP_BIN' 2>/dev/null | head -1")
  if [[ -z "$FULL_BIN" ]]; then
    echo "Error: '$MCP_BIN' not found on ${HOST:-local}"
    exit 1
  fi
  echo "Found: $FULL_BIN"

  # Build args JSON array
  ARGS_JSON="["
  for a in "${MCP_ARGS[@]:-}"; do
    [[ -n "$a" ]] && ARGS_JSON+="\"$a\","
  done
  ARGS_JSON="${ARGS_JSON%,}]"

  MCP_JSON="{\"command\":\"$FULL_BIN\",\"args\":$ARGS_JSON,\"env\":$MCP_ENV}"
  echo "Adding MCP '$MCP_NAME': $MCP_JSON"

  run_remote "cd '$PATH_' && claude mcp remove '$MCP_NAME' -s local 2>/dev/null || true"
  run_remote "cd '$PATH_' && claude mcp add-json '$MCP_NAME' '$MCP_JSON' -s local"
  echo "MCP added."

# Run arbitrary command if provided
elif [[ $# -gt 0 ]]; then
  echo "Running: $*"
  run_remote "cd '$PATH_' && $*"
  echo "Command done."
fi

# Restart Claude (send 'q Enter' to quit gracefully, loop restarts it)
echo "Restarting Claude in tmux session '$SESSION'..."
run_remote "tmux send-keys -t '$SESSION' q Enter"
echo "Done. Claude will restart automatically via the loop."
