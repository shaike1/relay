#!/bin/bash
# audit-log.sh — Append a JSONL audit log entry for a tool call.
# Called from pre-tool-hook.sh (or directly) with tool info via environment or args.
# Usage: audit-log.sh <thread_id> <tool_name> <tool_input_json>
# Or via env: THREAD_ID, TOOL_NAME, TOOL_INPUT_JSON
set -euo pipefail

THREAD_ID="${1:-${THREAD_ID:-}}"
TOOL_NAME="${2:-${TOOL_NAME:-unknown}}"
TOOL_INPUT_JSON="${3:-${TOOL_INPUT_JSON:-{}}}"

if [ -z "$THREAD_ID" ]; then
  exit 0
fi

AUDIT_FILE="/tmp/relay-audit-${THREAD_ID}.jsonl"
TS=$(date +%s)

python3 -c "
import sys, json

thread_id = sys.argv[1]
tool = sys.argv[2]
input_json = sys.argv[3]
ts = int(sys.argv[4])

try:
    inp = json.loads(input_json)
except Exception:
    inp = input_json

entry = {
    'ts': ts,
    'thread_id': thread_id,
    'tool': tool,
    'input': inp,
    'user': 'claude'
}
print(json.dumps(entry))
" "$THREAD_ID" "$TOOL_NAME" "$TOOL_INPUT_JSON" "$TS" >> "$AUDIT_FILE" 2>/dev/null || true
