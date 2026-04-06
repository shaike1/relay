#!/bin/bash
# pre-compact-extract.sh — Called by the PreCompact hook.
# Queues a message to the session asking Claude to save critical facts
# to memory before compaction wipes the context window.
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:-}"
[ -z "$THREAD_ID" ] && exit 0

QUEUE_FILE="/tmp/tg-queue-${THREAD_ID}.jsonl"
TS=$(date +%s)

python3 - "$QUEUE_FILE" "$TS" <<'PY'
import json, sys

queue_file, ts = sys.argv[1], int(sys.argv[2])

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
PY
