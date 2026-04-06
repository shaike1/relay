#!/bin/bash
# auto-summary.sh — generates a daily summary of session activity.
# Called by the scheduler (cron: "0 23 * * *") or manually.
# Reads last 50 messages from the queue, sends a summary request to Claude.
# Usage: auto-summary.sh  (env: TELEGRAM_THREAD_ID, SESSION_NAME, WORKDIR)
set -euo pipefail

THREAD_ID="${TELEGRAM_THREAD_ID:?TELEGRAM_THREAD_ID required}"
SESSION="${SESSION_NAME:-unknown}"
QUEUE="/tmp/tg-queue-${THREAD_ID}.jsonl"
MEMORY_DIR="${WORKDIR:-/root}/.relay-summaries"
DATE=$(date +%Y-%m-%d)

[ -f "$QUEUE" ] || exit 0

mkdir -p "$MEMORY_DIR"

# Extract last 50 user messages from today
MESSAGES=$(python3 -c "
import json, time
from datetime import datetime
queue = '$QUEUE'
today_start = datetime.now().replace(hour=0, minute=0, second=0).timestamp()
msgs = []
try:
    for line in open(queue):
        try:
            m = json.loads(line.strip())
            if m.get('ts', 0) >= today_start and m.get('text') and m.get('message_id', 0) > 0:
                msgs.append(f\"{m['user']}: {m['text'][:120]}\")
        except: pass
except: pass
print('\n'.join(msgs[-50:]))
" 2>/dev/null)

[ -z "$MESSAGES" ] && exit 0

# Write summary prompt to queue
SUMMARY_PROMPT="Please write a brief daily summary for session '${SESSION}' (${DATE}). Review today's activity and provide: 1) Main tasks completed, 2) Key decisions made, 3) Open items for tomorrow. Save the summary to memory/daily-summary-${DATE}.md. Keep it under 200 words."

python3 -c "
import json, time
entry = {
    'message_id': -(int(time.time()) % 2147483647),
    'user': 'scheduler',
    'text': '''$SUMMARY_PROMPT

Today messages:
$MESSAGES''',
    'ts': int(time.time()),
    'via': 'scheduler',
    'schedule_id': 'auto-summary',
}
with open('/tmp/tg-queue-${THREAD_ID}.jsonl', 'a') as f:
    f.write(json.dumps(entry) + '\n')
print('Summary prompt queued for session $SESSION')
"
