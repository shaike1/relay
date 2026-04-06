#!/usr/bin/env python3
"""
token-monitor.py — Standalone token optimizer monitor for bash-loop sessions.

Runs as a sidecar alongside claude-session-loop.sh + message-watchdog.sh.
Watches the tmux session output and queue files to track metrics and detect
waste patterns, without interfering with the existing session management.

Can also be called one-shot for stats: python3 token-monitor.py --stats

Environment:
  SESSION_NAME      — session name
  TELEGRAM_THREAD_ID — topic thread ID
  TELEGRAM_BOT_TOKEN — for sending alerts
  GROUP_CHAT_ID     — Telegram group
"""

import json
import os
import sys
import time
import subprocess
import signal
import logging
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from token_optimizer import WasteDetector, SmartCompactor, format_findings_html

logging.basicConfig(
    level=logging.INFO,
    format="[token-monitor:%(name)s] %(message)s",
    stream=sys.stderr,
)

SESSION_NAME = os.environ.get("SESSION_NAME", "")
THREAD_ID = os.environ.get("TELEGRAM_THREAD_ID", "")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("GROUP_CHAT_ID", "")

log = logging.getLogger(SESSION_NAME or "monitor")


def tg_send(text: str):
    """Send message to Telegram."""
    if not BOT_TOKEN or not CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    params = {"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML"}
    if THREAD_ID:
        params["message_thread_id"] = int(THREAD_ID)
    data = json.dumps(params).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log.error(f"Telegram send error: {e}")


def get_tmux_session_name() -> str:
    """Find the tmux session for this claude session."""
    try:
        result = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name}"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.strip().split("\n"):
            if SESSION_NAME in line or "claude" in line.lower():
                return line.strip()
    except Exception:
        pass
    return ""


def get_tmux_output(session: str, lines: int = 50) -> str:
    """Capture recent tmux pane output."""
    if not session:
        return ""
    try:
        result = subprocess.run(
            ["tmux", "capture-pane", "-t", session, "-p", "-S", f"-{lines}"],
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout
    except Exception:
        return ""


def estimate_context_from_tmux(output: str) -> dict:
    """Parse tmux output for context clues about session health."""
    stats = {
        "has_error": False,
        "has_tool_use": False,
        "response_lines": 0,
        "empty_lines": 0,
    }

    for line in output.split("\n"):
        line = line.strip()
        if not line:
            stats["empty_lines"] += 1
            continue
        stats["response_lines"] += 1
        if any(err in line.lower() for err in ["error", "failed", "exception", "timeout"]):
            stats["has_error"] = True
        if line.startswith("● ") or line.startswith("⎿ "):
            stats["has_tool_use"] = True

    return stats


def read_queue_activity() -> dict:
    """Check queue file for message activity."""
    queue_file = f"/tmp/tg-queue-{THREAD_ID}.jsonl"
    state_file = f"/tmp/tg-queue-{THREAD_ID}.state"

    stats = {"queue_messages": 0, "last_processed_id": 0, "pending": 0}

    if os.path.exists(queue_file):
        try:
            with open(queue_file) as f:
                stats["queue_messages"] = sum(1 for _ in f)
        except Exception:
            pass

    if os.path.exists(state_file):
        try:
            with open(state_file) as f:
                state = json.load(f)
                stats["last_processed_id"] = state.get("lastId", 0)
        except Exception:
            pass

    return stats


def monitor_loop():
    """Main monitoring loop — run as sidecar daemon."""
    log.info(f"Starting token monitor for session={SESSION_NAME}, thread={THREAD_ID}")

    detector = WasteDetector(session_name=SESSION_NAME)
    compactor = SmartCompactor(session_name=SESSION_NAME)

    CHECK_INTERVAL = 60  # check every minute
    ALERT_INTERVAL = 600  # alert at most every 10 minutes
    CHECKPOINT_INTERVAL = 1800  # checkpoint every 30 minutes

    last_alert = 0
    last_checkpoint = time.time()
    last_queue_count = 0

    running = True
    def shutdown(sig, frame):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    while running:
        try:
            # Check queue activity
            queue_stats = read_queue_activity()
            new_messages = queue_stats["queue_messages"] - last_queue_count

            if new_messages > 0:
                # Approximate: each new queue message = one ask() cycle
                tmux_session = get_tmux_session_name()
                tmux_output = get_tmux_output(tmux_session)
                tmux_stats = estimate_context_from_tmux(tmux_output)

                # Record approximate metric
                detector.record(
                    prompt=f"queue_message x{new_messages}",
                    response=tmux_output[-500:] if tmux_output else "",
                    elapsed=CHECK_INTERVAL,  # approximate
                    user="queue",
                    timed_out=False,
                )
                last_queue_count = queue_stats["queue_messages"]

            # Periodic waste analysis
            now = time.time()
            if now - last_alert > ALERT_INTERVAL:
                findings = detector.analyze()
                critical = [f for f in findings if f.severity in ("critical", "high")]
                if critical:
                    stats = detector.get_stats()
                    report = format_findings_html(critical, stats)
                    if report:
                        tg_send(report)
                        last_alert = now

            # Periodic checkpoint
            if now - last_checkpoint > CHECKPOINT_INTERVAL:
                # Build conversation history from queue
                conv = build_conversation_from_queue()
                if conv and len(conv) > 10:
                    compactor.capture(conv, trigger="auto", reason="Periodic monitor checkpoint")
                last_checkpoint = now

        except Exception as e:
            log.error(f"Monitor error: {e}")

        time.sleep(CHECK_INTERVAL)

    log.info("Token monitor shutting down")


def build_conversation_from_queue() -> list[dict]:
    """Build approximate conversation history from queue file."""
    queue_file = f"/tmp/tg-queue-{THREAD_ID}.jsonl"
    if not os.path.exists(queue_file):
        return []

    messages = []
    try:
        with open(queue_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    messages.append({
                        "role": "user",
                        "content": msg.get("text", ""),
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                    time.gmtime(msg.get("ts", 0))),
                    })
                except Exception:
                    continue
    except Exception:
        pass

    return messages


def show_stats():
    """One-shot: show current stats."""
    detector = WasteDetector(session_name=SESSION_NAME)
    stats = detector.get_stats()
    findings = detector.analyze()

    print(f"Session: {SESSION_NAME}")
    print(f"Stats: {json.dumps(stats, indent=2)}")
    if findings:
        print(f"\nFindings ({len(findings)}):")
        for f in findings:
            print(f"  [{f.severity}] {f.waste_type}: {f.description}")
    else:
        print("No waste patterns detected.")


if __name__ == "__main__":
    if "--stats" in sys.argv:
        show_stats()
    else:
        monitor_loop()
