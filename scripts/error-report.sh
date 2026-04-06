#!/bin/bash
# error-report.sh — Read /tmp/relay-errors.jsonl and send a summary to Telegram.
# Can be called manually or via cron.
#
# Usage:
#   bash /relay/scripts/error-report.sh [--last N]
#
# Options:
#   --last N   Show only the last N errors (default: 20)
#
# Env vars required (or loaded from /root/relay/.env):
#   TELEGRAM_BOT_TOKEN
#   GROUP_CHAT_ID
#   ALERT_THREAD_ID (optional — defaults to first session thread_id from sessions.json)

set -euo pipefail

ERROR_LOG="${ERROR_LOG:-/tmp/relay-errors.jsonl}"
SESSIONS_FILE="${SESSIONS_FILE:-/relay/sessions.json}"
LAST_N=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --last) LAST_N="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Load .env if tokens not set
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && [ -f /root/relay/.env ]; then
  # shellcheck disable=SC1091
  set -a; source /root/relay/.env; set +a
fi

TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${GROUP_CHAT_ID:-}"

# Resolve alert thread_id
THREAD_ID="${ALERT_THREAD_ID:-}"
if [ -z "$THREAD_ID" ] && [ -f "$SESSIONS_FILE" ]; then
  THREAD_ID=$(python3 -c "
import json, sys
try:
    s = json.load(open('$SESSIONS_FILE'))
    if s: print(s[0]['thread_id'])
except Exception: pass
" 2>/dev/null || echo "")
fi

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ] || [ -z "$THREAD_ID" ]; then
  echo "[error-report] Missing TELEGRAM_BOT_TOKEN / GROUP_CHAT_ID / thread_id — cannot send" >&2
  # Still print to stdout
  if [ -f "$ERROR_LOG" ]; then
    echo "=== Last $LAST_N errors from $ERROR_LOG ==="
    tail -n "$LAST_N" "$ERROR_LOG" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        print(f\"[{e.get('t','')}] {e.get('type','')} — {e.get('message','')[:200]}\")
    except: print(line[:200])
"
  else
    echo "No error log found at $ERROR_LOG"
  fi
  exit 0
fi

if [ ! -f "$ERROR_LOG" ]; then
  TEXT="✅ <b>relay-api errors</b>\nNo error log found — no errors recorded."
  TOTAL=0
else
  TOTAL=$(wc -l < "$ERROR_LOG" | tr -d ' ')
  if [ "$TOTAL" -eq 0 ]; then
    TEXT="✅ <b>relay-api errors</b>\nError log is empty."
  else
    SUMMARY=$(tail -n "$LAST_N" "$ERROR_LOG" | python3 -c "
import sys, json
lines = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        ts = e.get('t','')[:19]
        tp = e.get('type','')
        msg = e.get('message','')[:120]
        lines.append(f'• [{ts}] {tp}: {msg}')
    except:
        lines.append(f'• {line[:140]}')
print('\n'.join(lines))
" 2>/dev/null || echo "(parse error)")
    TEXT="⚠️ <b>relay-api error report</b> (last $LAST_N of $TOTAL)\n\n<pre>$(echo "$SUMMARY" | sed 's/[<>&]/./g')</pre>"
  fi
fi

# Send to Telegram
curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json, sys
print(json.dumps({
  'chat_id': '$CHAT_ID',
  'message_thread_id': int('$THREAD_ID'),
  'text': sys.argv[1],
  'parse_mode': 'HTML',
}))" "$TEXT")" | python3 -c "import json,sys; r=json.load(sys.stdin); print('Sent ok, msg_id:', r.get('result',{}).get('message_id','?') if r.get('ok') else 'FAILED: '+str(r))"

echo "[error-report] Done. Total errors in log: $TOTAL"
