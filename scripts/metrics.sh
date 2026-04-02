#!/bin/bash
# metrics.sh — Generate JSON metrics for all relay sessions
# Output: JSON array with session status, activity, context
set -euo pipefail

SESSIONS_FILE="/root/relay/sessions.json"

python3 - "$SESSIONS_FILE" <<'PY'
import json, sys, os, subprocess, time

sessions_file = sys.argv[1]
try:
    sessions = json.load(open(sessions_file))
except Exception:
    print("[]")
    sys.exit(0)

metrics = []
now = time.time()

for s in sessions:
    name = s.get("session", "?")
    thread_id = s.get("thread_id", 0)
    host = s.get("host")
    path = s.get("path", "/root")
    stype = s.get("type", "claude")

    entry = {
        "session": name,
        "type": stype,
        "path": path,
        "host": host or "local",
        "thread_id": thread_id,
        "status": "unknown",
        "last_active": None,
        "last_active_ago": None,
        "container": f"relay-session-{name}",
        "context": None,
    }

    # Check container status
    container = f"relay-session-{name}"
    try:
        result = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Status}}", container],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            entry["status"] = result.stdout.strip()
        else:
            entry["status"] = "not found"
    except Exception:
        entry["status"] = "error"

    # Check last activity
    last_sent_file = f"/tmp/tg-last-sent-{thread_id}"
    try:
        with open(last_sent_file) as f:
            ts = float(f.read().strip())
            ago = int(now - ts)
            entry["last_active"] = ts
            if ago < 60:
                entry["last_active_ago"] = f"{ago}s ago"
            elif ago < 3600:
                entry["last_active_ago"] = f"{ago // 60}m ago"
            else:
                entry["last_active_ago"] = f"{ago // 3600}h {(ago % 3600) // 60}m ago"
    except Exception:
        entry["last_active_ago"] = "unknown"

    # Check pending messages in queue
    queue_file = f"/tmp/tg-queue-{thread_id}.jsonl"
    state_file = f"/tmp/tg-queue-{thread_id}.state"
    try:
        last_id = 0
        if os.path.exists(state_file):
            state = json.load(open(state_file))
            last_id = state.get("lastId", 0)
        pending = 0
        if os.path.exists(queue_file):
            with open(queue_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                        if msg.get("message_id", 0) > last_id:
                            pending += 1
                    except Exception:
                        pass
        entry["pending_messages"] = pending
    except Exception:
        entry["pending_messages"] = 0

    metrics.append(entry)

# Sort: running first, then by last activity
metrics.sort(key=lambda m: (
    0 if m["status"] == "running" else 1,
    -(m["last_active"] or 0)
))

print(json.dumps(metrics, indent=2))
PY
