#!/bin/bash
# pre-compact-extract.sh — Called by the PreCompact hook.
# 1. Queues a message asking Claude to save critical facts to memory.
# 2. Writes a SESSION_SUMMARY.md to the workdir from the session JSONL.
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:-}"
[ -z "$THREAD_ID" ] && exit 0

QUEUE_FILE="/tmp/tg-queue-${THREAD_ID}.jsonl"
WORKDIR="${WORKDIR:-/root}"
SESSION="${SESSION_NAME:-session}"
TS=$(date +%s)

python3 - "$QUEUE_FILE" "$TS" "$WORKDIR" "$SESSION" "$THREAD_ID" <<'PY'
import json, sys, os
from datetime import datetime

queue_file, ts, workdir, session, thread_id = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]

# 1. Queue memory_write nudge
entry = {
    "message_id": -ts,
    "user": "system",
    "text": "Before compaction, please call memory_write to save any critical facts, decisions, or open tasks that should survive the context reset.",
    "ts": ts,
    "via": "pre-compact-hook",
    "force": True,
}
with open(queue_file, "a") as f:
    f.write(json.dumps(entry) + "\n")

# 2. Write SESSION_SUMMARY.md from the session JSONL
project_key = workdir.replace("/", "-").strip("-")
project_dir = os.path.expanduser(f"~/.claude/projects/{project_key}")
if not os.path.isdir(project_dir):
    sys.exit(0)

import glob
files = sorted(glob.glob(f"{project_dir}/*.jsonl"), key=os.path.getmtime, reverse=True)
if not files:
    sys.exit(0)

latest = files[0]
try:
    lines = open(latest).readlines()
except Exception:
    sys.exit(0)

# Extract key info from the session
tool_calls = []
files_changed = []
bash_cmds = []
last_texts = []
total_input = total_output = 0

for line in lines:
    try:
        d = json.loads(line.strip())
        if d.get("type") == "assistant":
            u = d.get("message", {}).get("usage", {})
            total_input = max(total_input, u.get("input_tokens", 0))
            total_output += u.get("output_tokens", 0)
            for block in d.get("message", {}).get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    name = block.get("name", "")
                    inp = block.get("input", {}) or {}
                    if name and name not in tool_calls:
                        tool_calls.append(name)
                    if name in ("Edit", "Write", "create") and "file_path" in inp:
                        fp = inp["file_path"]
                        if fp not in files_changed:
                            files_changed.append(fp)
                    if name == "Bash" and "command" in inp:
                        cmd = (inp.get("command") or "")[:80].split("\n")[0].strip()
                        if cmd and cmd not in bash_cmds and len(bash_cmds) < 5:
                            bash_cmds.append(cmd)
                if block.get("type") == "text":
                    t = (block.get("text") or "").strip()
                    if t and len(last_texts) < 3:
                        last_texts.append(t[:300])
    except Exception:
        pass

now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
summary_path = os.path.join(workdir, "SESSION_SUMMARY.md")

lines_out = [
    f"# Session Summary — {session}",
    f"**Compacted:** {now_str}  ",
    f"**Context at compact:** ~{total_input:,} input tokens / {total_output:,} output tokens",
    "",
    "## Tools used",
    ", ".join(tool_calls[:15]) if tool_calls else "_none_",
    "",
]
if files_changed:
    lines_out += ["## Files changed", ""]
    lines_out += [f"- `{f}`" for f in files_changed[:20]]
    lines_out.append("")
if bash_cmds:
    lines_out += ["## Recent commands", ""]
    lines_out += [f"- `{c}`" for c in bash_cmds]
    lines_out.append("")
if last_texts:
    lines_out += ["## Last assistant responses", ""]
    for t in last_texts:
        lines_out.append(f"> {t[:200]}")
        lines_out.append("")

try:
    with open(summary_path, "w") as f:
        f.write("\n".join(lines_out))
    print(f"[pre-compact] Wrote {summary_path}", file=sys.stderr)
except Exception as e:
    print(f"[pre-compact] Failed to write summary: {e}", file=sys.stderr)
PY

