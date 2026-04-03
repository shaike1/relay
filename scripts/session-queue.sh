#!/bin/bash
# session-queue.sh — Read queue contents for a session
# Usage: session-queue.sh <thread_id> [max_lines]
set -euo pipefail

THREAD_ID="${1:?Usage: session-queue.sh <thread_id> [max_lines]}"
MAX="${2:-50}"

QUEUE_FILE="/tmp/tg-queue-${THREAD_ID}.jsonl"
STATE_FILE="/tmp/tg-queue-${THREAD_ID}.state"

echo "{"

# Queue messages
if [ -f "$QUEUE_FILE" ]; then
    echo "\"messages\": $(tail -n "$MAX" "$QUEUE_FILE" | python3 -c "
import sys, json
lines = []
for line in sys.stdin:
    line = line.strip()
    if line:
        try:
            lines.append(json.loads(line))
        except:
            lines.append({'raw': line})
print(json.dumps(lines))
"),"
else
    echo "\"messages\": [],"
fi

# State
if [ -f "$STATE_FILE" ]; then
    echo "\"state\": $(cat "$STATE_FILE"),"
else
    echo "\"state\": null,"
fi

# Counts
if [ -f "$QUEUE_FILE" ]; then
    echo "\"total_lines\": $(wc -l < "$QUEUE_FILE")"
else
    echo "\"total_lines\": 0"
fi

echo "}"
