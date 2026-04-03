#!/bin/bash
# aggregate-tasks.sh — Collect tasks from all sessions into one JSON
set -euo pipefail

SESSIONS_FILE="${1:-/relay/sessions.json}"
RESULT="{"

FIRST=true
for name in $(python3 -c "
import json
sessions = json.load(open('$SESSIONS_FILE'))
for s in sessions:
    print(s['session'])
" 2>/dev/null); do
    TASKS_FILE="/tmp/relay-tasks-${name}.json"
    if [ -f "$TASKS_FILE" ] && [ -s "$TASKS_FILE" ]; then
        CONTENT=$(cat "$TASKS_FILE" 2>/dev/null || echo "{}")
        if [ "$FIRST" = true ]; then
            FIRST=false
        else
            RESULT+=","
        fi
        RESULT+="\"${name}\":${CONTENT}"
    fi
done

RESULT+="}"
echo "$RESULT"
