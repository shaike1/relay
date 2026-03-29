#!/bin/bash
# sessions-watchdog.sh — check all local sessions; restart dead ones, nudge stuck ones.
# Runs every few minutes via systemd timer.
set -euo pipefail

SESSIONS_JSON="${1:-/root/relay/sessions.json}"
LOOP_SCRIPT="/root/relay/scripts/claude-session-loop.sh"
NUDGE="You have telegram MCP tools available. Call fetch_messages to check for and respond to any pending messages from the user."

python3 - "$SESSIONS_JSON" "$LOOP_SCRIPT" "$NUDGE" <<'PYEOF'
import json, subprocess, sys, os

sessions_file = sys.argv[1]
loop_script   = sys.argv[2]
nudge_msg     = sys.argv[3]

with open(sessions_file) as f:
    sessions = json.load(f)

for s in sessions:
    name = s["session"]
    path = s.get("path", "/root")
    host = s.get("host")

    if host or not os.path.isdir(path):
        continue

    alive = subprocess.run(["tmux", "has-session", "-t", name],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if alive.returncode != 0:
        # Dead — restart
        cmd = f"bash {loop_script} {name} {path}"
        subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", path, cmd], check=True)
        print(f"[watchdog] restarted dead session: {name}")
        continue

    # Alive — check if Claude is stuck ("MCP tools unavailable")
    pane = subprocess.run(["tmux", "capture-pane", "-t", name, "-p"],
                          capture_output=True, text=True)
    pane_text = pane.stdout if pane.returncode == 0 else ""
    stuck_phrases = ["MCP tools.*unavailable", "not available", "tools are not available",
                     "can't reach them via Telegram", "cannot reach"]
    import re
    is_stuck = any(re.search(p, pane_text, re.IGNORECASE) for p in stuck_phrases)
    if is_stuck:
        subprocess.run(["tmux", "send-keys", "-t", name, nudge_msg, "Enter"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"[watchdog] nudged stuck session: {name}")

PYEOF
