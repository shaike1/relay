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

# Write current input token count (context size) to a simple state file
# so message-watchdog.sh can trigger /compact when context gets too large
ctx_file = f"/tmp/relay-ctx-tokens-{thread_id}"
try:
    with open(ctx_file, "w") as f:
        f.write(str(entry["input"]))
except Exception:
    pass

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
            # Extract tool names, files changed, bash commands, and last assistant text
            tool_names = []
            files_changed = []
            bash_cmds = []
            last_text = ""
            for line in reversed(lines[-150:]):
                try:
                    d = json.loads(line.strip())
                    if d.get("type") == "assistant":
                        for block in d.get("message", {}).get("content", []):
                            if isinstance(block, dict):
                                if block.get("type") == "tool_use":
                                    name = block.get("name", "")
                                    inp = block.get("input", {}) or {}
                                    if name and name not in tool_names and len(tool_names) < 5:
                                        tool_names.append(name)
                                    # Track files changed
                                    if name in ("Edit", "Write") and "file_path" in inp:
                                        fname = inp["file_path"].split("/")[-1]
                                        if fname and fname not in files_changed and len(files_changed) < 5:
                                            files_changed.append(fname)
                                    # Track bash commands
                                    elif name == "Bash" and "command" in inp:
                                        cmd = (inp.get("command") or "")[:50].split("\n")[0].strip()
                                        if cmd and cmd not in bash_cmds and len(bash_cmds) < 3:
                                            bash_cmds.append(cmd)
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
                content_parts = [f"Tools: {tools_str}."]
                if files_changed:
                    content_parts.append(f"Files: {', '.join(files_changed)}.")
                if bash_cmds:
                    content_parts.append(f"Commands: {'; '.join(bash_cmds)}.")
                if last_text:
                    content_parts.append(f"Summary: {last_text}")
                content = " ".join(content_parts)
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
