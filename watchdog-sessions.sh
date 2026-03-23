#!/usr/bin/env python3
"""
relay watchdog — keeps all Claude+MCP sessions alive.

Checks every session in sessions.json:
  - MCP lock file exists and PID is alive
  - If dead: kills Claude so the bash loop restarts it (which respawns MCP)

Sends a Telegram alert when a session is auto-recovered.
Run via systemd timer every 60s (see relay-watchdog.timer).
"""
import json, os, subprocess, sys, time, signal
from pathlib import Path

RELAY_DIR    = Path(__file__).parent
SESSIONS     = RELAY_DIR / "sessions.json"
ENV_FILE     = Path.home() / ".claude" / "channels" / "telegram" / ".env"
LOG_FILE     = Path("/tmp/relay-watchdog.log")
ALERT_STATE  = Path("/tmp/relay-watchdog-alerted.json")
ALERT_COOLDOWN = 1800  # seconds (30 min) between alerts per session

# ── helpers ─────────────────────────────────────────────────────────────────

def log(msg: str):
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def load_env() -> dict:
    env = {}
    try:
        for line in ENV_FILE.read_text().splitlines():
            m = line.split("=", 1)
            if len(m) == 2:
                env[m[0].strip()] = m[1].strip()
    except Exception:
        pass
    return env

def send_alert(token: str, chat_id: str, thread_id: str, text: str):
    try:
        subprocess.run([
            "curl", "-s", "-X", "POST",
            f"https://api.telegram.org/bot{token}/sendMessage",
            "-d", f"chat_id={chat_id}",
            "-d", f"message_thread_id={thread_id}",
            "-d", "parse_mode=HTML",
            "--data-urlencode", f"text={text}",
        ], capture_output=True, timeout=10)
    except Exception as e:
        log(f"alert send failed: {e}")

def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False

def lock_pid(thread_id: int, host: str | None) -> int | None:
    lock_file = f"/tmp/tg-queue-{thread_id}.lock"
    if host:
        r = subprocess.run(
            ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", host,
             f"cat {lock_file} 2>/dev/null"],
            capture_output=True, text=True, timeout=10
        )
        raw = r.stdout.strip()
    else:
        try:
            raw = Path(lock_file).read_text().strip()
        except FileNotFoundError:
            return None
    return int(raw) if raw.isdigit() else None

def pid_alive_remote(pid: int, host: str) -> bool:
    r = subprocess.run(
        ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", host,
         f"kill -0 {pid} 2>/dev/null && echo alive || echo dead"],
        capture_output=True, text=True, timeout=10
    )
    return r.stdout.strip() == "alive"

def find_claude_pid(session: str, host: str | None) -> int | None:
    """Return the PID of the claude process in the tmux session's pane."""
    cmd = f"tmux display -t {session} -p '#{{pane_pid}}' 2>/dev/null"
    if host:
        r = subprocess.run(
            ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", host, cmd],
            capture_output=True, text=True, timeout=10
        )
        pane_pid_str = r.stdout.strip()
    else:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        pane_pid_str = r.stdout.strip()

    if not pane_pid_str.isdigit():
        return None
    pane_pid = int(pane_pid_str)

    # Find claude child of the pane's bash
    pgrep_cmd = f"pgrep -P {pane_pid} claude 2>/dev/null | head -1"
    if host:
        r = subprocess.run(
            ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", host, pgrep_cmd],
            capture_output=True, text=True, timeout=10
        )
        pid_str = r.stdout.strip()
    else:
        r = subprocess.run(pgrep_cmd, shell=True, capture_output=True, text=True)
        pid_str = r.stdout.strip()

    return int(pid_str) if pid_str.isdigit() else None

def kill_remote(pid: int, host: str):
    subprocess.run(
        ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", host,
         f"kill {pid} 2>/dev/null"],
        capture_output=True, timeout=10
    )

def remove_lock(thread_id: int, host: str | None):
    lock_file = f"/tmp/tg-queue-{thread_id}.lock"
    if host:
        subprocess.run(
            ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", host,
             f"rm -f {lock_file}"],
            capture_output=True, timeout=10
        )
    else:
        try:
            os.unlink(lock_file)
        except FileNotFoundError:
            pass

# ── main ─────────────────────────────────────────────────────────────────────

def main():
    env = load_env()
    token   = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_CHAT_ID", "")

    # Relay topic thread_id for alerts (find 'relay' session)
    configs = json.loads(SESSIONS.read_text())
    relay_cfg = next((c for c in configs if c.get("session") == "relay"), {})
    alert_thread = str(relay_cfg.get("thread_id", ""))

    # Load per-session alert timestamps
    try:
        alert_times: dict = json.loads(ALERT_STATE.read_text()) if ALERT_STATE.exists() else {}
    except Exception:
        alert_times = {}

    recovered = []

    for cfg in configs:
        session   = cfg["session"]
        thread_id = cfg.get("thread_id")
        host      = cfg.get("host") or None

        if not thread_id:
            continue

        # Check if MCP lock exists and process is alive
        try:
            mcp_pid = lock_pid(thread_id, host)
            if mcp_pid is None:
                mcp_alive = False
            else:
                mcp_alive = pid_alive(mcp_pid) if not host else pid_alive_remote(mcp_pid, host)
        except Exception as e:
            log(f"{session}: error checking lock — {e}")
            continue

        if mcp_alive:
            continue  # healthy

        log(f"{session} (t={thread_id}): MCP dead — recovering...")

        # Clean up stale lock
        remove_lock(thread_id, host)

        # Kill Claude so bash loop restarts it and spawns fresh MCP
        try:
            claude_pid = find_claude_pid(session, host)
            if claude_pid:
                if host:
                    kill_remote(claude_pid, host)
                else:
                    os.kill(claude_pid, signal.SIGTERM)
                log(f"{session}: killed claude PID {claude_pid}")
            else:
                log(f"{session}: no claude PID found, lock removed — loop should restart")
        except Exception as e:
            log(f"{session}: error killing claude — {e}")

        recovered.append(session)

    now = time.time()
    if recovered and token and chat_id and alert_thread:
        # Only alert for sessions not alerted in the last 30 min
        to_alert = [s for s in recovered if now - alert_times.get(s, 0) >= ALERT_COOLDOWN]
        if to_alert:
            sessions_list = ", ".join(f"<code>{s}</code>" for s in to_alert)
            send_alert(token, chat_id, alert_thread,
                       f"🔄 Watchdog auto-recovered: {sessions_list}")
            for s in to_alert:
                alert_times[s] = now
            ALERT_STATE.write_text(json.dumps(alert_times))
            log(f"Alert sent for: {to_alert}")
        else:
            log(f"Recovered {recovered} but all within cooldown — no alert sent")

    if not recovered:
        log("All sessions healthy.")

if __name__ == "__main__":
    main()
