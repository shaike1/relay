#!/bin/bash
# restart-all-sessions.sh — restart all Claude sessions across all hosts
#
# Usage:
#   ./restart-all-sessions.sh          # restart all sessions
#   ./restart-all-sessions.sh <host>   # restart only sessions on a specific host (or "local")
#
# Useful after changing ~/.claude/settings.json to apply new settings.

set -euo pipefail

SESSIONS_FILE="$(dirname "$0")/sessions.json"
FILTER_HOST="${1:-}"

RELAY_DIR="$(dirname "$0")"
MCP_SERVER="$RELAY_DIR/mcp-telegram/server.ts"

echo "Reading sessions from $SESSIONS_FILE..."

# Sync .env, server.ts, and bot token in ~/.claude.json to all remote hosts
python3 - "$SESSIONS_FILE" "$RELAY_DIR" <<'SYNCEOF'
import json, subprocess, sys, os, re

cfgs = json.load(open(sys.argv[1]))
relay_dir = sys.argv[2]
hosts = {c["host"] for c in cfgs if c.get("host")}

# Read local bot token from .env
local_token = ""
env_path = os.path.join(relay_dir, ".env")
try:
    for line in open(env_path).read().splitlines():
        m = re.match(r'^TELEGRAM_BOT_TOKEN=(.+)$', line)
        if m:
            local_token = m.group(1).strip()
            break
except Exception:
    pass

for host in hosts:
    print(f"  Syncing .env to {host}...")
    subprocess.run(["scp", "-o", "StrictHostKeyChecking=no",
        env_path, f"{host}:/root/relay/.env"],
        capture_output=True)
    print(f"  Syncing mcp-telegram/server.ts to {host}...")
    subprocess.run(["scp", "-o", "StrictHostKeyChecking=no",
        f"{relay_dir}/mcp-telegram/server.ts", f"{host}:/root/relay/mcp-telegram/server.ts"],
        capture_output=True)
    # Update bot token in ~/.claude.json on the remote host
    # (Claude stores per-project MCP configs there; stale tokens block MCP startup)
    if local_token:
        print(f"  Updating TELEGRAM_BOT_TOKEN in ~/.claude.json on {host}...")
        update_cmd = (
            f"python3 -c \""
            f"import json, re; "
            f"path='/root/.claude.json'; "
            f"txt=open(path).read(); "
            f"txt=re.sub(r'(TELEGRAM_BOT_TOKEN\\\\\\\":\\s*\\\\\\\")[^\\\"]+', "
            f"r'\\\\g<1>{local_token}', txt); "
            f"open(path,'w').write(txt)"
            f"\""
        )
        subprocess.run(["ssh", "-o", "StrictHostKeyChecking=no", host, update_cmd],
            capture_output=True)
SYNCEOF

python3 - "$SESSIONS_FILE" "$FILTER_HOST" <<'EOF'
import json, subprocess, sys, time

sessions_file = sys.argv[1]
filter_host   = sys.argv[2]

configs = json.load(open(sessions_file))

restarted = 0
for cfg in configs:
    session = cfg["session"]
    host    = cfg.get("host") or ""

    # Never restart the relay session itself — it manages all others
    if session == "relay":
        print(f"  Skipping 'relay' (self)")
        continue

    # Filter by host if requested
    if filter_host:
        target = "" if filter_host == "local" else filter_host
        if host != target:
            continue

    host_label = host or "local"
    print(f"  Restarting '{session}' on {host_label}...")

    ssh_prefix = ["ssh", "-o", "StrictHostKeyChecking=no", host] if host else []

    # Send 'q Enter' to quit Claude gracefully; loop restarts it
    subprocess.run(
        ssh_prefix + ["tmux", "send-keys", "-t", session, "q", "Enter"],
        capture_output=True
    )
    time.sleep(0.3)
    restarted += 1

print(f"\nDone — restarted {restarted} session(s).")
EOF
