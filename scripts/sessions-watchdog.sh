#!/bin/bash
# sessions-watchdog.sh — check all local sessions; restart any that died.
# Runs every few minutes via systemd timer.
set -euo pipefail

SESSIONS_JSON="${1:-/root/relay/sessions.json}"
LOOP_SCRIPT="/root/relay/scripts/claude-session-loop.sh"

python3 - "$SESSIONS_JSON" <<'PYEOF'
import json, subprocess, sys, os

sessions_file = sys.argv[1]
loop_script   = "/root/relay/scripts/claude-session-loop.sh"

with open(sessions_file) as f:
    sessions = json.load(f)

for s in sessions:
    name = s["session"]
    path = s.get("path", "/root")
    host = s.get("host")

    if host or not os.path.isdir(path):
        continue

    result = subprocess.run(["tmux", "has-session", "-t", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode == 0:
        continue  # alive

    # Dead — restart
    cmd = f"bash {loop_script} {name} {path}"
    subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", path, cmd], check=True)
    print(f"[watchdog] restarted dead session: {name}")

PYEOF
