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

# --- Auto-summarize logic ---
try:
    import time, secrets

    output_tokens = entry.get("output", 0)
    if output_tokens > 200:
        cooldown_file = f"/tmp/relay-autosummary-lastrun-{thread_id}"
        now = int(time.time())
        last_run = 0
        try:
            last_run = int(open(cooldown_file).read().strip())
        except Exception:
            pass

        if now - last_run >= 1800:
            # Extract tool names and last assistant text from last 150 lines
            tool_names = []
            last_text = ""
            for line in reversed(lines[-150:]):
                try:
                    d = json.loads(line.strip())
                    if d.get("type") == "assistant":
                        for block in d.get("message", {}).get("content", []):
                            if isinstance(block, dict):
                                if block.get("type") == "tool_use" and len(tool_names) < 5:
                                    name = block.get("name", "")
                                    if name and name not in tool_names:
                                        tool_names.append(name)
                                if block.get("type") == "text" and not last_text:
                                    last_text = (block.get("text", "") or "")[:200]
                except Exception:
                    pass

            knowledge_file = "/root/.claude/relay-knowledge.json"
            try:
                existing = json.loads(open(knowledge_file).read())
            except Exception:
                existing = []

            # Skip if we already wrote an entry for this session in the last 30 min
            cutoff = now - 1800
            recent = any(
                e.get("author") == session and e.get("ts", 0) > cutoff
                for e in existing
            )

            if not recent:
                tools_str = ", ".join(tool_names) if tool_names else "none"
                content = f"Tools used: {tools_str}. Last response: {last_text}"
                new_entry = {
                    "id": secrets.token_hex(4),
                    "title": f"[{session}] session summary",
                    "content": content,
                    "tags": ["auto-summary", session],
                    "author": session,
                    "ts": now,
                }
                existing.append(new_entry)
                with open(knowledge_file, "w") as f:
                    f.write(json.dumps(existing, indent=2))
                open(cooldown_file, "w").write(str(now))
except Exception:
    pass
PY
