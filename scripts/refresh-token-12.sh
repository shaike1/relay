#!/usr/bin/env bash
# refresh-token-12.sh — refresh Claude OAuth token on .12 (this host)
# Runs every 3 hours via cron. Updates ~/.claude/.credentials.json
# and restarts relay session containers so they pick up the new token.
set -euo pipefail

CREDS_FILE="$HOME/.claude/.credentials.json"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
LOG_FILE="/tmp/claude-token-refresh-12.log"
SCOPES="user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }

if [ ! -f "$CREDS_FILE" ]; then
    log "ERROR: $CREDS_FILE not found"
    exit 1
fi

REFRESH_TOKEN=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d['claudeAiOauth']['refreshToken'])")
EXPIRES_AT=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d['claudeAiOauth']['expiresAt'])")
NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
TIME_LEFT=$(( EXPIRES_AT - NOW_MS ))

if [ "$TIME_LEFT" -gt 7200000 ]; then
    log "Token OK, expires in $(( TIME_LEFT / 3600000 ))h $(( (TIME_LEFT % 3600000) / 60000 ))m — no refresh needed"
    exit 0
fi

log "Token expires in $(( TIME_LEFT / 60000 ))m — refreshing..."

for attempt in 1 2 3; do
    RESPONSE=$(curl -s --max-time 20 -X POST https://platform.claude.com/v1/oauth/token \
        -H "Content-Type: application/json" \
        -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"$REFRESH_TOKEN\",\"client_id\":\"$CLIENT_ID\",\"scope\":\"$SCOPES\"}" 2>/dev/null)

    if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'access_token' in d else 1)" 2>/dev/null; then
        NEW_ACCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['access_token'])")
        NEW_REFRESH=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('refresh_token','$REFRESH_TOKEN'))")
        EXPIRES_IN=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('expires_in',28800))")
        NEW_EXPIRES_AT=$(python3 -c "import time; print(int(time.time()*1000) + $EXPIRES_IN * 1000)")

        python3 << PYEOF
import json
f = '$CREDS_FILE'
d = json.load(open(f))
d['claudeAiOauth']['accessToken'] = '$NEW_ACCESS'
d['claudeAiOauth']['refreshToken'] = '$NEW_REFRESH'
d['claudeAiOauth']['expiresAt'] = $NEW_EXPIRES_AT
open(f,'w').write(json.dumps(d))
PYEOF

        log "Token refreshed OK (attempt $attempt). Expires in ${EXPIRES_IN}s"

        # Also update .env CLAUDE_CODE_OAUTH_TOKEN so new containers get it
        ENV_FILE="/root/relay/.env"
        if [ -f "$ENV_FILE" ]; then
            if grep -q 'CLAUDE_CODE_OAUTH_TOKEN' "$ENV_FILE"; then
                sed -i "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$NEW_ACCESS|" "$ENV_FILE"
            else
                echo "CLAUDE_CODE_OAUTH_TOKEN=$NEW_ACCESS" >> "$ENV_FILE"
            fi
            log "Updated .env with new token"
        fi

        # Restart oauth sessions so they pick up new token
        for container in relay-session-edushare relay-session-teamy relay-session-right-api-web relay-session-headscale relay-session-duplicacy; do
            if docker ps -q --filter "name=$container" | grep -q .; then
                docker restart "$container" > /dev/null 2>&1 && log "Restarted $container" || log "WARN: could not restart $container"
            fi
        done

        exit 0
    fi

    ERR=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error_description', d.get('error','unknown')))" 2>/dev/null || echo "no response/timeout")
    log "Attempt $attempt failed: $ERR"
    [ "$attempt" -lt 3 ] && sleep 30
done

log "ERROR: all refresh attempts failed — token may expire soon"
exit 1
