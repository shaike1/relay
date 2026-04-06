#!/usr/bin/env python3
"""
session-driver.py — oauth-cli-coder based session driver.

Replaces claude-session-loop.sh + message-watchdog.sh with a single Python
process that:
  1. Starts a Claude Code session via oauth-cli-coder (tmux-managed)
  2. Polls the Telegram queue file for incoming messages
  3. Sends prompts to Claude via ask()
  4. Posts responses directly to Telegram via HTTP API

Environment:
  SESSION_NAME        — session name (from sessions.json)
  SESSION_TYPE        — "claude" (default) or "codex"
  TELEGRAM_BOT_TOKEN  — bot token for sending responses
  GROUP_CHAT_ID       — Telegram group chat ID
  TELEGRAM_THREAD_ID  — topic thread ID
  WORK_DIR            — working directory for Claude (default: from sessions.json)
  ASK_TIMEOUT         — seconds to wait for Claude response (default: 300)
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
import signal
import logging
from pathlib import Path
from typing import Optional

# Token optimizer — waste detection + smart compaction
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from token_optimizer import WasteDetector, SmartCompactor, format_findings_html

logging.basicConfig(
    level=logging.INFO,
    format="[session-driver:%(name)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(os.environ.get("SESSION_NAME", "unknown"))

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SESSION_NAME = os.environ.get("SESSION_NAME", "")
SESSION_TYPE = os.environ.get("SESSION_TYPE", "claude")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("GROUP_CHAT_ID", "")
THREAD_ID = os.environ.get("TELEGRAM_THREAD_ID", "")
WORK_DIR = os.environ.get("WORK_DIR", "")
ASK_TIMEOUT = int(os.environ.get("ASK_TIMEOUT", "300"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "3"))

SESSIONS_FILE = "/root/relay/sessions.json"
QUEUE_DIR = "/tmp"

# tmux sockets must NOT live on the shared /tmp volume (relay-queue).
# Override TMPDIR so tmux creates its socket under a container-local directory.
TMUX_TMPDIR = "/var/tmp/tmux-driver"
os.makedirs(TMUX_TMPDIR, exist_ok=True)
os.environ["TMPDIR"] = TMUX_TMPDIR

# ---------------------------------------------------------------------------
# Resolve session config from sessions.json if not fully specified via env
# ---------------------------------------------------------------------------
def load_session_config():
    global THREAD_ID, WORK_DIR, BOT_TOKEN, SESSION_NAME
    if not SESSION_NAME:
        log.error("SESSION_NAME required")
        sys.exit(1)

    try:
        with open(SESSIONS_FILE) as f:
            sessions = json.load(f)
        session = next((s for s in sessions if s["session"] == SESSION_NAME), None)
        if session:
            if not THREAD_ID:
                THREAD_ID = str(session.get("thread_id", ""))
            if not WORK_DIR:
                WORK_DIR = session.get("path", "/root")
            # Codex sessions may have their own bot token
            if session.get("bot_token") and not BOT_TOKEN:
                BOT_TOKEN = session["bot_token"]
    except Exception as e:
        log.warning(f"Could not load sessions.json: {e}")

    if not WORK_DIR:
        WORK_DIR = "/root"

load_session_config()

QUEUE_FILE = os.path.join(QUEUE_DIR, f"tg-queue-{THREAD_ID}.jsonl")
STATE_FILE = os.path.join(QUEUE_DIR, f"tg-queue-{THREAD_ID}.state")

# ---------------------------------------------------------------------------
# Telegram HTTP helpers
# ---------------------------------------------------------------------------
def tg_api(method: str, params: dict) -> dict:
    """Call Telegram Bot API."""
    if not BOT_TOKEN:
        log.warning("No BOT_TOKEN — cannot send to Telegram")
        return {}
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = json.dumps(params).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        log.error(f"Telegram API error ({method}): {e}")
        return {}


def send_typing():
    """Send typing indicator."""
    tg_api("sendChatAction", {
        "chat_id": CHAT_ID,
        "message_thread_id": int(THREAD_ID) if THREAD_ID else None,
        "action": "typing",
    })


def send_message(text: str, reply_to: Optional[int] = None):
    """Send a message to the Telegram topic. Splits long messages."""
    MAX_LEN = 4000
    chunks = []
    while len(text) > MAX_LEN:
        # Split at last newline before limit
        split_at = text.rfind("\n", 0, MAX_LEN)
        if split_at < 0:
            split_at = MAX_LEN
        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")
    chunks.append(text)

    for i, chunk in enumerate(chunks):
        params = {
            "chat_id": CHAT_ID,
            "text": chunk,
            "parse_mode": "HTML",
        }
        if THREAD_ID:
            params["message_thread_id"] = int(THREAD_ID)
        if reply_to and i == 0:
            params["reply_to_message_id"] = reply_to
        tg_api("sendMessage", params)


# ---------------------------------------------------------------------------
# Queue reader
# ---------------------------------------------------------------------------
def read_pending_messages() -> list:
    """Read unprocessed messages from the queue file."""
    if not os.path.exists(QUEUE_FILE):
        return []

    last_id = 0
    last_ts = 0
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                state = json.load(f)
                last_id = state.get("lastId", 0)
                last_ts = state.get("lastTs", 0)
        except Exception:
            pass

    pending = []
    seen_ids = set()
    try:
        with open(QUEUE_FILE) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    mid = msg.get("message_id", 0)
                    ts = msg.get("ts", 0)
                    # Deduplicate: skip if we've already seen this message_id
                    if mid > 0 and mid in seen_ids:
                        continue
                    if mid > 0:
                        seen_ids.add(mid)
                    # Regular messages
                    if mid > 0 and mid > last_id:
                        pending.append(msg)
                    # System/forced messages (negative IDs)
                    elif mid < 0 and ts > last_ts:
                        pending.append(msg)
                except Exception:
                    continue
    except Exception as e:
        log.warning(f"Error reading queue: {e}")

    return pending


def mark_processed(messages: list):
    """Update state file after processing messages."""
    if not messages:
        return
    max_id = max((m.get("message_id", 0) for m in messages if m.get("message_id", 0) > 0), default=0)
    max_ts = max((m.get("ts", 0) for m in messages), default=0)

    state = {}
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                state = json.load(f)
        except Exception:
            pass

    if max_id > state.get("lastId", 0):
        state["lastId"] = max_id
    if max_ts > state.get("lastTs", 0):
        state["lastTs"] = max_ts

    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


# ---------------------------------------------------------------------------
# MCP config — ensure Claude has the right Telegram thread_id
# ---------------------------------------------------------------------------
def write_mcp_config():
    """Write .mcp.json with correct thread_id in the working directory."""
    mcp_path = os.path.join(WORK_DIR, ".mcp.json")
    try:
        existing = {}
        if os.path.exists(mcp_path):
            with open(mcp_path) as f:
                existing = json.load(f)
    except Exception:
        existing = {}

    existing.setdefault("mcpServers", {})
    existing["mcpServers"]["telegram"] = {
        "command": "/root/.bun/bin/bun",
        "args": ["run", "--cwd", "/root/relay/mcp-telegram", "server.ts"],
        "env": {
            "TELEGRAM_THREAD_ID": THREAD_ID,
            "SESSION_NAME": SESSION_NAME,
        },
    }
    with open(mcp_path, "w") as f:
        json.dump(existing, f, indent=2)
    log.info(f"Wrote MCP config to {mcp_path} (thread={THREAD_ID})")


# ---------------------------------------------------------------------------
# Claude/Codex session via oauth-cli-coder
# ---------------------------------------------------------------------------
_provider = None


def get_provider():
    """Get or create the Claude/Codex provider."""
    global _provider
    if _provider is not None:
        return _provider

    from oauth_cli_coder import ClaudeProvider, CodexProvider

    TMUX_SOCKET = f"/var/tmp/tmux-driver-{SESSION_NAME}.sock"

    import subprocess as _sp

    def _tmux_run(cmd):
        """Run a tmux command with our custom socket."""
        if cmd and cmd[0] == "tmux":
            cmd = ["tmux", "-S", TMUX_SOCKET] + cmd[1:]
        return _sp.run(cmd, capture_output=True, text=True)

    # Custom provider that uses explicit tmux socket and correct permissions
    class RelayClaudeProvider(ClaudeProvider):
        def get_start_cmd(self):
            cmd = ["claude", "--permission-mode", "auto", "--remote-control"]
            if self.model:
                cmd.extend(["--model", self.model])
            return cmd

        def _run_cmd(self, cmd):
            return _tmux_run(cmd).stdout.strip()

        def _has_session(self):
            return _tmux_run(["tmux", "has-session", "-t", self.session_name]).returncode == 0

        def close(self):
            _tmux_run(["tmux", "kill-session", "-t", self.session_name])

    class RelayCodexProvider(CodexProvider):
        def get_start_cmd(self):
            cmd = ["codex", "--yolo", "--dangerously-bypass-approvals-and-sandbox"]
            if self.model:
                cmd.extend(["--model", self.model])
            return cmd

        def _run_cmd(self, cmd):
            return _tmux_run(cmd).stdout.strip()

        def _has_session(self):
            return _tmux_run(["tmux", "has-session", "-t", self.session_name]).returncode == 0

        def close(self):
            _tmux_run(["tmux", "kill-session", "-t", self.session_name])

    session_id = f"relay-{SESSION_NAME}"
    log.info(f"Starting {SESSION_TYPE} provider (session_id={session_id}, cwd={WORK_DIR})")

    if SESSION_TYPE == "codex":
        _provider = RelayCodexProvider(cwd=WORK_DIR, session_id=session_id)
    else:
        _provider = RelayClaudeProvider(cwd=WORK_DIR, session_id=session_id)

    log.info(f"Provider started: {_provider.session_name}")
    return _provider


def ask_claude(prompt: str, user: str = "") -> str:
    """Send a prompt to Claude/Codex and get the response. Tracks metrics."""
    provider = get_provider()
    start = time.time()
    timed_out = False
    try:
        response = provider.ask(prompt, timeout=ASK_TIMEOUT)
        response = response.strip() if response else ""
    except Exception as e:
        log.error(f"ask() failed: {e}")
        response = f"Error: {e}"
        if "timeout" in str(e).lower() or "Timeout" in str(e):
            timed_out = True

    elapsed = time.time() - start

    # Record metrics for waste detection
    if _waste_detector:
        _waste_detector.record(prompt, response, elapsed, user=user, timed_out=timed_out)

    return response


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------
def build_system_context() -> str:
    """Build initial system context for the session."""
    agents_path = os.path.join(WORK_DIR, "AGENTS.md")
    claude_md_path = os.path.join(WORK_DIR, "CLAUDE.md")

    context_parts = []
    for p in [claude_md_path, agents_path]:
        if os.path.exists(p):
            try:
                context_parts.append(Path(p).read_text()[:2000])
            except Exception:
                pass

    return "\n\n".join(context_parts)


def format_user_prompt(msg: dict) -> str:
    """Format a queue message into a prompt for Claude."""
    text = msg.get("text", "")
    user = msg.get("user", "unknown")
    reply_text = msg.get("reply_text", "")

    prompt = f"[Telegram message from {user}]\n{text}"
    if reply_text:
        prompt = f"[Replying to: {reply_text}]\n{prompt}"
    return prompt


# ---------------------------------------------------------------------------
# Token optimizer globals
# ---------------------------------------------------------------------------
_waste_detector: Optional[WasteDetector] = None
_smart_compactor: Optional[SmartCompactor] = None
_conversation_history: list[dict] = []
_last_waste_check: float = 0
WASTE_CHECK_INTERVAL = 600  # check for waste patterns every 10 minutes
COMPACTION_CHECK_INTERVAL = 1800  # consider compaction every 30 minutes
_last_compaction_check: float = 0


def _check_waste_patterns():
    """Periodically analyze waste patterns and alert if needed."""
    global _last_waste_check
    now = time.time()
    if now - _last_waste_check < WASTE_CHECK_INTERVAL:
        return
    _last_waste_check = now

    if not _waste_detector:
        return

    findings = _waste_detector.analyze()
    if not findings:
        return

    # Only alert on high/critical findings
    critical = [f for f in findings if f.severity in ("critical", "high")]
    if not critical:
        return

    stats = _waste_detector.get_stats()
    report = format_findings_html(critical, stats)
    if report:
        log.warning(f"Waste detected: {len(critical)} critical/high findings")
        send_message(report)


def _check_compaction():
    """Periodically capture smart checkpoint if conversation is getting long."""
    global _last_compaction_check
    now = time.time()
    if now - _last_compaction_check < COMPACTION_CHECK_INTERVAL:
        return
    _last_compaction_check = now

    if not _smart_compactor or len(_conversation_history) < 20:
        return

    filepath = _smart_compactor.capture(
        _conversation_history,
        trigger="auto",
        reason=f"Periodic checkpoint at {len(_conversation_history)} messages",
    )
    if filepath:
        log.info(f"Auto-checkpoint saved: {filepath}")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    global _waste_detector, _smart_compactor, _last_waste_check, _last_compaction_check

    log.info(f"Session driver starting: session={SESSION_NAME}, type={SESSION_TYPE}, "
             f"thread={THREAD_ID}, workdir={WORK_DIR}")

    if not THREAD_ID:
        log.error("No THREAD_ID — cannot operate without a Telegram topic")
        sys.exit(1)

    # Initialize token optimizer
    _waste_detector = WasteDetector(session_name=SESSION_NAME)
    _smart_compactor = SmartCompactor(session_name=SESSION_NAME)
    _last_waste_check = time.time()
    _last_compaction_check = time.time()

    # Restore checkpoint context if available
    restored = _smart_compactor.restore()
    if restored:
        log.info(f"Restored checkpoint ({len(restored)} chars)")

    log.info(f"Token optimizer initialized: waste detector + smart compactor")

    # Graceful shutdown — only on explicit SIGTERM, not SIGINT (from docker exec)
    running = True
    def shutdown(sig, frame):
        nonlocal running
        log.info(f"Received signal {sig}, shutting down...")
        running = False
    signal.signal(signal.SIGTERM, shutdown)
    # Ignore SIGINT in detached mode — avoids spurious shutdown from container signals
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    # Ensure MCP config has the correct thread_id for this session
    write_mcp_config()

    # Start the provider eagerly
    provider = get_provider()

    # Build startup prompt — include checkpoint context if we have one
    startup_prompt = (
        "You just started a new session. Call typing immediately, then send_message "
        "with a brief startup message. Then call fetch_messages and respond to any pending messages."
    )
    if restored:
        startup_prompt = (
            "You just restarted. Here is your previous session checkpoint:\n\n"
            f"{restored[:3000]}\n\n"
            "Call typing, then send_message acknowledging what you remember. "
            "Then call fetch_messages and respond to any pending messages."
        )

    # Send startup prompt — Claude will respond via MCP (Telegram)
    log.info("Sending startup prompt...")
    ask_claude(startup_prompt)
    log.info("Startup prompt completed")

    log.info("Entering message loop")

    while running:
        try:
            messages = read_pending_messages()
            if not messages:
                # Run periodic checks during idle time
                _check_waste_patterns()
                _check_compaction()
                time.sleep(POLL_INTERVAL)
                continue

            log.info(f"Processing {len(messages)} pending message(s)")

            for msg in messages:
                text = msg.get("text", "").strip()
                if not text:
                    continue

                mid = msg.get("message_id")
                user = msg.get("user", "unknown")
                log.info(f"Message from {user}: {text[:80]}...")

                # Track conversation history for smart compaction
                _conversation_history.append({
                    "role": "user",
                    "content": text,
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                })

                # Send prompt to Claude — Claude handles its own Telegram response via MCP
                prompt = format_user_prompt(msg)
                response = ask_claude(prompt, user=user)

                # Track assistant response
                if response:
                    _conversation_history.append({
                        "role": "assistant",
                        "content": response,
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    })

                if not response:
                    log.warning(f"No response for message {mid} — Claude may have timed out")
                    # Fallback: send error via direct API
                    send_message("(Session timeout — please try again)",
                                reply_to=mid if mid and mid > 0 else None)

                # Run waste check after each message
                _check_waste_patterns()

            mark_processed(messages)

        except Exception as e:
            log.error(f"Loop error: {e}", exc_info=True)
            time.sleep(5)

    # Shutdown: capture final checkpoint
    if _smart_compactor and _conversation_history:
        log.info("Capturing shutdown checkpoint...")
        _smart_compactor.capture(
            _conversation_history,
            trigger="session-end",
            reason="Session shutting down",
        )

    # Cleanup
    log.info("Shutting down provider...")
    if _provider:
        try:
            _provider.close()
        except Exception:
            pass
    log.info("Done.")


def clean_response(text: str) -> str:
    """Remove terminal artifacts and tool-use displays from response."""
    lines = text.split("\n")
    cleaned = []
    skip = False
    for line in lines:
        # Skip Claude Code tool-use displays
        if line.strip().startswith("● ") or line.strip().startswith("⎿ "):
            skip = True
            continue
        if skip and line.startswith("  "):
            continue
        skip = False
        cleaned.append(line)
    return "\n".join(cleaned).strip()


if __name__ == "__main__":
    main()
