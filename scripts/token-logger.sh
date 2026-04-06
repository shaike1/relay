#!/bin/bash
# token-logger.sh — called by Claude Code Stop hook after each response.
# Reads token usage from the latest session JSONL and appends to a stats file.
# Usage: token-logger.sh (reads CLAUDE_PROJECT_KEY, THREAD_ID, SESSION_NAME from env)
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:-}"
SESSION="${SESSION_NAME:-unknown}"

[ -z "$THREAD_ID" ] && exit 0

# Find the project dir (same logic as claude-session-loop.sh)
WORKDIR="${WORKDIR:-/root}"
PROJECT_KEY=$(echo "$WORKDIR" | sed 's|/|-|g; s|[^a-zA-Z0-9._-]|-|g')
PROJECT_DIR="${HOME}/.claude/projects/${PROJECT_KEY}"

[ -d "$PROJECT_DIR" ] || exit 0

# Get most recent session file
LATEST=$(ls -t "${PROJECT_DIR}"/*.jsonl 2>/dev/null | head -1)
[ -z "$LATEST" ] && exit 0

# Extract usage from the last assistant message with non-zero tokens
python3 - "$LATEST" "$THREAD_ID" "$SESSION" <<'PY'
import json, sys, os
from datetime import datetime

jsonl_file, thread_id, session = sys.argv[1], sys.argv[2], sys.argv[3]
stats_file = f"/tmp/token-stats-{thread_id}.jsonl"

try:
    lines = open(jsonl_file).readlines()
except Exception:
    sys.exit(0)

usage = None
for line in reversed(lines[-100:]):
    try:
        d = json.loads(line.strip())
        if d.get('type') == 'assistant':
            u = d.get('message', {}).get('usage', {})
            total = u.get('input_tokens', 0) + u.get('output_tokens', 0)
            if total > 0:
                usage = u
                break
    except Exception:
        pass

if not usage:
    sys.exit(0)

entry = {
    "ts": datetime.now().isoformat(),
    "session": session,
    "input": usage.get("input_tokens", 0),
    "output": usage.get("output_tokens", 0),
    "cache_read": usage.get("cache_read_input_tokens", 0),
    "cache_write": usage.get("cache_creation_input_tokens", 0),
}

# Sonnet 4.6 pricing (per 1M tokens)
INPUT_PRICE = 3.0
OUTPUT_PRICE = 15.0
CACHE_READ_PRICE = 0.30
CACHE_WRITE_PRICE = 3.75

cost = (
    entry["input"] * INPUT_PRICE / 1_000_000 +
    entry["output"] * OUTPUT_PRICE / 1_000_000 +
    entry["cache_read"] * CACHE_READ_PRICE / 1_000_000 +
    entry["cache_write"] * CACHE_WRITE_PRICE / 1_000_000
)
entry["cost_usd"] = round(cost, 6)

with open(stats_file, "a") as f:
    f.write(json.dumps(entry) + "\n")

# --- Auto-compact threshold check ---
import datetime
threshold = int(os.environ.get("TOKEN_COMPACT_THRESHOLD", "50000"))
today = datetime.date.today().isoformat()
flag_file = f"/tmp/relay-compact-triggered-{today}-{thread_id}"

if not os.path.exists(flag_file):
    # Sum today's output tokens for this session
    total_output = 0
    try:
        for line in open(stats_file):
            try:
                r = json.loads(line.strip())
                if r.get("ts", "").startswith(today):
                    total_output += r.get("output", 0)
            except Exception:
                pass
    except Exception:
        pass

    if total_output > threshold:
        ts = int(datetime.datetime.now().timestamp())
        queue_file = f"/tmp/tg-queue-{thread_id}.jsonl"
        compact_entry = {
            "message_id": -ts,
            "user": "system",
            "text": "/compact — context approaching limit, auto-compacting",
            "ts": ts,
            "via": "token-monitor",
            "force": True,
        }
        with open(queue_file, "a") as f:
            f.write(json.dumps(compact_entry) + "\n")
        # Write flag to prevent multiple triggers today
        open(flag_file, "w").close()
        print(f"[token-monitor] Auto-compact triggered for thread {thread_id} (output={total_output} > threshold={threshold})", file=sys.stderr)
PY
