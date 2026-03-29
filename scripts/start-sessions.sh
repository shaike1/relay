#!/bin/bash
# start-sessions.sh — start all local Claude relay sessions in tmux.
# Reads sessions.json, skips remote sessions (host != null).
# Safe to run multiple times; skips sessions that are already running.
set -euo pipefail

SESSIONS_JSON="${1:-/root/relay/sessions.json}"
LOOP_SCRIPT="/root/relay/scripts/claude-session-loop.sh"

if [ ! -f "$SESSIONS_JSON" ]; then
  echo "[start-sessions] sessions.json not found: $SESSIONS_JSON" >&2
  exit 1
fi

python3 - "$SESSIONS_JSON" <<'PYEOF'
import json, subprocess, sys, os

sessions_file = sys.argv[1]
loop_script   = "/root/relay/scripts/claude-session-loop.sh"

with open(sessions_file) as f:
    sessions = json.load(f)

for s in sessions:
    name    = s["session"]
    path    = s.get("path", "/root")
    host    = s.get("host")

    if host:
        # Remote session — managed on the remote host
        print(f"[start-sessions] skipping remote: {name} ({host})")
        continue

    if not os.path.isdir(path):
        print(f"[start-sessions] skipping {name}: path not found: {path}")
        continue

    # Check if tmux session already has an active process
    result = subprocess.run(
        ["tmux", "has-session", "-t", name],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    if result.returncode == 0:
        print(f"[start-sessions] already running: {name}")
        continue

    # Create tmux session and start the loop
    cmd = f"bash {loop_script} {name} {path}"
    subprocess.run([
        "tmux", "new-session", "-d", "-s", name, "-c", path, cmd
    ], check=True)
    print(f"[start-sessions] started: {name} @ {path}")

PYEOF
