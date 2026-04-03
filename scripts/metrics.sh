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

# Pre-fetch all container memory stats in one call
# Only if we can do it fast (timeout 8s — on host it's ~3s, inside container it can hang)
mem_stats = {}
try:
    result = subprocess.run(
        ["docker", "stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}"],
        capture_output=True, text=True, timeout=8
    )
    if result.returncode == 0:
        for line in result.stdout.strip().split("\n"):
            if "|" not in line: continue
            cname, mem = line.split("|", 1)
            mem_str = mem.split("/")[0].strip()
            try:
                if "GiB" in mem_str:
                    mem_stats[cname] = round(float(mem_str.replace("GiB", "").strip()) * 1024)
                elif "MiB" in mem_str:
                    mem_stats[cname] = round(float(mem_str.replace("MiB", "").strip()))
            except: pass
except subprocess.TimeoutExpired:
    pass  # Skip memory stats if too slow (inside container)
except: pass

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
        "pending_messages": 0,
        "uptime": None,
        "memory_mb": None,
    }

    # Check container status
    container = f"relay-session-{name}"
    try:
        result = subprocess.run(
            ["docker", "inspect", "--format",
             "{{.State.Status}}|{{.State.StartedAt}}|{{.HostConfig.Memory}}",
             container],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            parts = result.stdout.strip().split("|")
            entry["status"] = parts[0]
            # Calculate uptime
            if len(parts) > 1 and parts[0] == "running":
                try:
                    from datetime import datetime, timezone
                    ts_str = parts[1].split(".")[0]  # strip nanoseconds
                    started = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                    uptime_s = int((datetime.now(timezone.utc) - started).total_seconds())
                    if uptime_s < 3600:
                        entry["uptime"] = f"{uptime_s // 60}m"
                    elif uptime_s < 86400:
                        entry["uptime"] = f"{uptime_s // 3600}h {(uptime_s % 3600) // 60}m"
                    else:
                        entry["uptime"] = f"{uptime_s // 86400}d {(uptime_s % 86400) // 3600}h"
                except Exception:
                    pass
        else:
            entry["status"] = "not found"
    except Exception:
        entry["status"] = "error"

    # Memory from pre-fetched batch stats
    if container in mem_stats:
        entry["memory_mb"] = mem_stats[container]

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
