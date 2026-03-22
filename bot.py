import asyncio
import os
import json
import re
import subprocess
import logging
import time
from telegram import Update, Bot, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, MessageHandler, CommandHandler,
    CallbackQueryHandler, filters, ContextTypes
)

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

OWNER_ID      = int(os.environ.get("OWNER_ID", "0"))
GROUP_CHAT_ID = int(os.environ.get("GROUP_CHAT_ID", "0"))
TOKEN         = os.environ.get("TELEGRAM_BOT_TOKEN", "")

# Webhook config (optional — falls back to polling if not set)
WEBHOOK_URL   = os.environ.get("WEBHOOK_URL", "")   # e.g. https://YOUR_PUBLIC_IP:88
WEBHOOK_PORT  = int(os.environ.get("WEBHOOK_PORT", "18793"))
WEBHOOK_CERT  = os.environ.get("WEBHOOK_CERT", "")  # path to self-signed cert for upload

POLL_INTERVAL     = 2
MAX_LINES         = 2000
STATUS_INTERVAL   = 180   # seconds between periodic status updates while Claude is active
CONFIG_FILE       = os.path.join(os.path.dirname(__file__), "sessions.json")
HOSTS_FILE        = os.path.join(os.path.dirname(__file__), "hosts.json")

# Runtime state
sessions: dict[tuple[int, int], str] = {}        # (chat_id, thread_id) -> session_name
session_to_thread: dict[str, tuple[int, int]] = {}
line_counts: dict[str, int] = {}
session_busy: dict[str, bool] = {}   # tracks whether session was "Working…" last poll
last_status_time: dict[str, float] = {}      # session -> timestamp of last status update
last_activity_time: dict[str, float] = {}    # session -> timestamp of last line-count change
last_user_sent: dict[str, float] = {}        # session -> timestamp of last user message sent

ANSI_RE = re.compile(r'\x1b\[[0-9;]*[mGKHF]|\x1b\][^\x07]*\x07|\r')

# ─── persistent config ────────────────────────────────────────────────────────

def load_config() -> list[dict]:
    """Load session configs from JSON file."""
    if not os.path.exists(CONFIG_FILE):
        return []
    with open(CONFIG_FILE) as f:
        return json.load(f)


def save_config(configs: list[dict]):
    with open(CONFIG_FILE, "w") as f:
        json.dump(configs, f, indent=2)


def get_configs() -> list[dict]:
    return load_config()


def add_config(entry: dict):
    configs = load_config()
    configs = [c for c in configs if c.get("thread_id") != entry["thread_id"]]
    configs.append(entry)
    save_config(configs)


def load_hosts() -> list[str]:
    """Load explicitly registered hosts for discovery."""
    if not os.path.exists(HOSTS_FILE):
        return []
    with open(HOSTS_FILE) as f:
        return json.load(f)


def save_hosts(hosts: list[str]):
    with open(HOSTS_FILE, "w") as f:
        json.dump(hosts, f, indent=2)


def all_discovery_hosts() -> list[str | None]:
    """Local + registered hosts + hosts already in session configs."""
    explicit  = load_hosts()
    from_cfgs = [cfg["host"] for cfg in get_configs() if cfg.get("host")]
    seen = set()
    result = [None]  # always include local
    for h in explicit + from_cfgs:
        if h and h not in seen:
            seen.add(h)
            result.append(h)
    return result


# ─── ssh / tmux helpers ───────────────────────────────────────────────────────

def ssh_prefix(host: str | None) -> list[str]:
    if host:
        return ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", host]
    return []


def run_cmd(cmd: list[str], host: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(ssh_prefix(host) + cmd, capture_output=True, text=True)


def tmux_exists(session: str, host: str | None = None) -> bool:
    return run_cmd(["tmux", "has-session", "-t", session], host).returncode == 0


def tmux_capture(session: str, host: str | None = None) -> list[str]:
    r = run_cmd(["tmux", "capture-pane", "-p", "-S", "-", "-t", session], host)
    lines = r.stdout.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def tmux_send(session: str, keys: str, host: str | None = None):
    # Use -l (literal) flag to preserve spaces and special characters
    run_cmd(["tmux", "send-keys", "-t", session, "-l", keys], host)
    run_cmd(["tmux", "send-keys", "-t", session, "Enter"], host)


def tmux_send_ctrl(session: str, key: str, host: str | None = None):
    run_cmd(["tmux", "send-keys", "-t", session, key, ""], host)


def path_to_claude_dir(path: str) -> str:
    """Convert /root/teamy -> root-teamy (Claude replaces / and . with -)"""
    return "".join("-" if c in "/." else c for c in path.lstrip("/"))


def claude_dir_to_path(dir_name: str) -> str:
    """Best-effort reverse: -root--openclaw-workspace -> /root/.openclaw/workspace"""
    s = dir_name.lstrip("-")
    # -- means /. (hidden dir), single - means /
    result = ""
    i = 0
    while i < len(s):
        if s[i] == "-":
            if i + 1 < len(s) and s[i + 1] == "-":
                result += "/."
                i += 2
            else:
                result += "/"
                i += 1
        else:
            result += s[i]
            i += 1
    return "/" + result


def scan_claude_projects(host: str | None = None) -> list[dict]:
    """Return all Claude projects with session history on a host."""
    base = "~/.claude/projects"
    if host:
        r = run_cmd(["bash", "-c",
            f"for d in {base}/*/; do "
            f"  count=$(ls \"$d\"*.jsonl 2>/dev/null | wc -l); "
            f"  if [ $count -gt 0 ]; then "
            f"    latest=$(ls -t \"$d\"*.jsonl 2>/dev/null | head -1); "
            f"    echo \"$count|$(stat -c %Y \"$latest\")|$d\"; "
            f"  fi; "
            f"done"], host)
        raw = r.stdout.strip().splitlines()
    else:
        base_exp = os.path.expanduser(base)
        raw = []
        for d in os.listdir(base_exp):
            full = os.path.join(base_exp, d)
            files = [f for f in os.listdir(full) if f.endswith(".jsonl")]
            if files:
                latest_mtime = max(os.path.getmtime(os.path.join(full, f)) for f in files)
                raw.append(f"{len(files)}|{int(latest_mtime)}|{full}/")

    results = []
    for line in raw:
        parts = line.strip().split("|")
        if len(parts) < 3:
            continue
        count, mtime, path = int(parts[0]), int(parts[1]), parts[2].rstrip("/")
        dir_name = os.path.basename(path)
        results.append({
            "dir":      dir_name,
            "path":     claude_dir_to_path(dir_name),
            "sessions": count,
            "last":     mtime,
            "host":     host,
        })
    return sorted(results, key=lambda x: x["last"], reverse=True)


def latest_claude_session(path: str, host: str | None = None) -> str | None:
    """Find the most recent Claude session ID for a given project path."""
    if host:
        # Remote: list the Claude project dir and find newest .jsonl
        proj_dir = f"~/.claude/projects/-{path_to_claude_dir(path)}"
        r = run_cmd(["bash", "-c",
            f"ls -t {proj_dir}/*.jsonl 2>/dev/null | head -1"], host)
        if r.returncode == 0 and r.stdout.strip():
            return os.path.basename(r.stdout.strip()).replace(".jsonl", "")
        return None
    else:
        proj_dir = os.path.expanduser(f"~/.claude/projects/-{path_to_claude_dir(path)}")
        if not os.path.isdir(proj_dir):
            return None
        files = sorted(
            [f for f in os.listdir(proj_dir) if f.endswith(".jsonl")],
            key=lambda f: os.path.getmtime(os.path.join(proj_dir, f)),
            reverse=True
        )
        return files[0].replace(".jsonl", "") if files else None


def write_mcp_json(path: str, thread_id: int, host: str | None = None):
    """Write .mcp.json into the project folder so Claude starts with the Telegram MCP server."""
    mcp_config = {
        "mcpServers": {
            "telegram": {
                "command": "/root/.bun/bin/bun",
                "args": ["run", "--cwd", "/root/relay/mcp-telegram", "--silent", "start"],
                "env": {
                    "TELEGRAM_THREAD_ID": str(thread_id),
                    "TELEGRAM_BOT_TOKEN": TOKEN,
                    "TELEGRAM_CHAT_ID": str(GROUP_CHAT_ID)
                }
            }
        }
    }
    content = json.dumps(mcp_config, indent=2)
    mcp_path = f"{path}/.mcp.json"

    if host:
        escaped = content.replace("'", "'\\''")
        run_cmd(["bash", "-c", f"cat > '{mcp_path}' << 'MCPEOF'\n{escaped}\nMCPEOF"], host)
    else:
        with open(mcp_path, "w") as f:
            f.write(content)
    logger.info(f"Wrote .mcp.json to {path} (thread_id={thread_id})")


def provision_session(session: str, path: str, host: str | None = None, thread_id: int | None = None, model: str | None = None):
    """Ensure tmux session exists at path, running Claude (resumed if possible)."""
    # Create project folder if needed
    run_cmd(["mkdir", "-p", path], host)

    # Write .mcp.json so Claude loads the Telegram channel
    if thread_id:
        write_mcp_json(path, thread_id, host)

    # Copy CLAUDE.md template so Claude knows to respond via send_message (not terminal)
    claude_md_src = os.path.join(os.path.dirname(__file__), "CLAUDE_TEMPLATE.md")
    claude_md_dst = f"{path}/CLAUDE.md"
    if host:
        try:
            with open(claude_md_src) as f:
                content = f.read()
            escaped = content.replace("'", "'\\''")
            run_cmd(["bash", "-c", f"cat > '{claude_md_dst}' << 'CLAUDEEOF'\n{escaped}\nCLAUDEEOF"], host)
        except Exception as e:
            logger.warning(f"Could not copy CLAUDE.md to {host}:{path}: {e}")
    else:
        if not os.path.exists(claude_md_dst):
            import shutil
            shutil.copy(claude_md_src, claude_md_dst)
            logger.info(f"Copied CLAUDE_TEMPLATE.md to {claude_md_dst}")

    if not tmux_exists(session, host):
        if host:
            run_cmd(["tmux", "new-session", "-d", "-s", session, "-c", path, "-x", "220", "-y", "50"], host)
        else:
            subprocess.run(["tmux", "new-session", "-d", "-s", session, "-c", path, "-x", "220", "-y", "50"],
                           capture_output=True)
    else:
        # Ensure existing sessions are wide enough for teams agents
        if host:
            # resize-window added in tmux 2.9; fall back to resize-pane for older versions
            r = run_cmd(["tmux", "resize-window", "-t", session, "-x", "220", "-y", "50"], host)
            if r.returncode != 0:
                run_cmd(["tmux", "resize-pane", "-t", f"{session}:0.0", "-x", "220", "-y", "50"], host)
        else:
            subprocess.run(["tmux", "resize-window", "-t", session, "-x", "220", "-y", "50"],
                           capture_output=True)

    # Use real claude binary on remote hosts to bypass any shell wrappers (e.g. Zellij)
    if host:
        r = run_cmd(["bash", "-c", "readlink -f $(which claude) 2>/dev/null || echo claude"], host)
        claude_bin = r.stdout.strip() or "claude"
    else:
        claude_bin = "claude"

    # Run claude in a loop so it auto-resumes on exit.
    # Use bash --norc --noprofile to avoid shell wrappers (e.g. Zellij auto-start in .bashrc).
    # Try --continue first; fall back to fresh start if no prior session exists
    model_flag = f" --model {model}" if model else ""
    env_prefix = "IS_SANDBOX=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
    base_flags = f"--dangerously-skip-permissions --remote-control{model_flag}"
    loop_cmd = (
        f"while true; do "
        f"{env_prefix} {claude_bin} {base_flags} --continue "
        f"|| {env_prefix} {claude_bin} {base_flags}; "
        f"sleep 1; done"
    )
    if host:
        run_cmd(["tmux", "respawn-pane", "-t", session, "-k",
                 f"bash --norc --noprofile -c '{loop_cmd}'"], host)
    else:
        subprocess.run(["tmux", "respawn-pane", "-t", session, "-k",
                        f"bash --norc --noprofile -c '{loop_cmd}'"],
                       capture_output=True)
    logger.info(f"Provisioned '{session}' on {host or 'local'} at {path} (auto-resume loop)")
    return "claude --resume <latest>"


# ─── load sessions at startup ─────────────────────────────────────────────────

def load_sessions():
    for cfg in get_configs():
        thread_id = cfg["thread_id"]
        session   = cfg["session"]
        host      = cfg.get("host")
        key       = (GROUP_CHAT_ID, thread_id)
        sessions[key] = session
        session_to_thread[session] = key
        if tmux_exists(session, host):
            line_counts[session] = len(tmux_capture(session, host))
        logger.info(f"Loaded: topic {thread_id} -> '{session}' on {host or 'local'}")


# ─── auth ─────────────────────────────────────────────────────────────────────

def owner_only(func):
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        uid = update.effective_user.id if update.effective_user else None
        if uid != OWNER_ID:
            logger.warning(f"owner_only: rejected user_id={uid} (expected {OWNER_ID}) fn={func.__name__}")
            return
        return await func(update, context)
    return wrapper


# ─── poller ───────────────────────────────────────────────────────────────────

def _read_last_response(thread_id: int, host: str | None) -> float:
    """Return the timestamp (epoch seconds) when Claude last sent a message on this thread."""
    resp_file = f"/tmp/tg-last-sent-{thread_id}"
    try:
        if host:
            r = run_cmd(["cat", resp_file], host)
            return float(r.stdout.strip()) if r.returncode == 0 else 0.0
        else:
            with open(resp_file) as f:
                return float(f.read().strip())
    except Exception:
        return 0.0


async def poll_output(context: ContextTypes.DEFAULT_TYPE):
    configs = {cfg["session"]: cfg for cfg in get_configs()}

    for (chat_id, thread_id), session in list(sessions.items()):
        cfg  = configs.get(session, {})
        host = cfg.get("host")
        path = cfg.get("path", "/root")

        try:
            if not tmux_exists(session, host):
                logger.warning(f"Session '{session}' gone — reprovisioning")
                provision_session(session, path, host, model=cfg.get("model"))
                line_counts[session] = len(tmux_capture(session, host))
                continue

            # Skip poll_output for MCP sessions — Claude sends replies via send_message tool
            # But send periodic status snapshots while the session is actively working.
            mcp_json = f"{path}/.mcp.json"
            has_mcp = (run_cmd(["test", "-f", mcp_json], host).returncode == 0) if host else os.path.exists(mcp_json)
            if has_mcp:
                lines = tmux_capture(session, host)
                line_counts[session] = len(lines)
                now   = time.time()

                continue

            lines     = tmux_capture(session, host)
            prev      = line_counts.get(session, len(lines))

            if len(lines) > prev:
                text = "\n".join(lines[prev:]).strip()
                if text:
                    for chunk in [text[i:i+4000] for i in range(0, len(text), 4000)]:
                        await context.bot.send_message(
                            chat_id=chat_id,
                            message_thread_id=thread_id,
                            text=f"<code>{_esc(chunk)}</code>",
                            parse_mode="HTML"
                        )
            line_counts[session] = len(lines)

        except Exception as e:
            logger.error(f"Poll error [{session}]: {e}")


# ─── helpers ──────────────────────────────────────────────────────────────────

def _esc(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _session_from_update(update: Update) -> tuple[str | None, dict]:
    chat_id   = update.effective_chat.id
    thread_id = update.message.message_thread_id
    session   = sessions.get((chat_id, thread_id))
    cfg       = next((c for c in get_configs() if c.get("session") == session), {})
    return session, cfg


# ─── commands ─────────────────────────────────────────────────────────────────

@owner_only
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "<b>Relay</b>\n\n"
        "<b>Provision:</b>\n"
        "/new [host] &lt;path&gt; — create session + topic\n"
        "/discover — find all Claude projects with history not yet connected\n\n"
        "<b>Session control (inside a topic):</b>\n"
        "/claude — start or resume Claude\n"
        "/restart — Ctrl+C + re-launch Claude\n"
        "/restart_all [host] — restart all sessions (after settings changes)\n"
        "/model [name] — show or switch Claude model (opus/sonnet/haiku or full ID)\n"
        "/switch [session] — reroute this topic to a different session\n"
        "/agents — show all running agents with status snapshot\n"
        "/link [session] — get Telegram link to a session's topic\n"
        "/kill — send Ctrl+C\n"
        "/snap — snapshot last 50 lines\n"
        "/mcp-add &lt;name&gt; &lt;binary&gt; [args...] [KEY=VAL...] — install MCP + restart\n\n"
        "<b>Info:</b>\n"
        "/sessions — list all sessions\n"
        "/status — show topic↔session map",
        parse_mode="HTML"
    )


@owner_only
async def cmd_addhost(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Register a host for discovery. Usage: /addhost 1.2.3.4 or user@host"""
    if not context.args:
        await update.message.reply_text("Usage: <code>/addhost [user@]host</code>", parse_mode="HTML")
        return

    raw  = context.args[0]
    host = raw if "@" in raw else f"root@{raw}"
    hosts = load_hosts()

    if host in hosts:
        await update.message.reply_text(f"<code>{_esc(host)}</code> already registered.", parse_mode="HTML")
        return

    # Test connectivity
    await update.message.reply_text(f"Testing connection to <code>{_esc(host)}</code>...", parse_mode="HTML")
    r = run_cmd(["echo", "ok"], host)
    if r.returncode != 0:
        await update.message.reply_text(
            f"Could not connect to <code>{_esc(host)}</code>.\n"
            f"Make sure SSH key auth is set up.\n<code>{_esc(r.stderr.strip())}</code>",
            parse_mode="HTML"
        )
        return

    hosts.append(host)
    save_hosts(hosts)
    await update.message.reply_text(
        f"Host <code>{_esc(host)}</code> added. Run /discover to scan it.",
        parse_mode="HTML"
    )


@owner_only
async def cmd_removehost(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        hosts = load_hosts()
        if not hosts:
            await update.message.reply_text("No registered hosts.")
        else:
            await update.message.reply_text(
                "<b>Registered hosts:</b>\n" +
                "\n".join(f"• <code>{_esc(h)}</code>" for h in hosts),
                parse_mode="HTML"
            )
        return

    raw  = context.args[0]
    host = raw if "@" in raw else f"root@{raw}"
    hosts = load_hosts()

    if host not in hosts:
        await update.message.reply_text(f"<code>{_esc(host)}</code> not in host list.", parse_mode="HTML")
        return

    hosts.remove(host)
    save_hosts(hosts)
    await update.message.reply_text(f"Removed <code>{_esc(host)}</code>.", parse_mode="HTML")


@owner_only
async def cmd_discover(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Scan all servers for Claude project history not yet wired to a topic."""
    await update.message.reply_text("Scanning for Claude projects with history...")

    hosts = all_discovery_hosts()

    # Already mapped paths
    mapped_dirs = {path_to_claude_dir(cfg["path"]) for cfg in get_configs()}

    all_projects = []
    for host in hosts:
        try:
            projects = scan_claude_projects(host)
            all_projects.extend(projects)
        except Exception as e:
            logger.error(f"Discover error on {host}: {e}")

    orphans = [p for p in all_projects if p["dir"].lstrip("-") not in
               {d.lstrip("-") for d in mapped_dirs}]
    mapped  = [p for p in all_projects if p["dir"].lstrip("-") in
               {d.lstrip("-") for d in mapped_dirs}]

    from datetime import datetime

    lines = ["<b>Already connected:</b>"]
    for p in mapped:
        dt = datetime.fromtimestamp(p["last"]).strftime("%m-%d %H:%M")
        lines.append(f"  ✓ <code>{_esc(p['path'])}</code> — {p['sessions']} sessions, last {dt}")

    if not orphans:
        lines.append("  All projects are connected.")
        await update.message.reply_text("\n".join(lines), parse_mode="HTML")
        return

    lines.append(f"\n<b>Not connected ({len(orphans)}) — tap to connect:</b>")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML")

    # One message per orphan with a Connect button
    for p in orphans:
        dt       = datetime.fromtimestamp(p["last"]).strftime("%m-%d %H:%M")
        host_str = p["host"] or "local"
        name     = os.path.basename(p["path"].rstrip("/"))
        # Encode as: host|path  (host is empty string for local)
        cb_data  = f"connect:{p['host'] or ''}|{p['path']}"

        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton("＋ Connect", callback_data=cb_data)
        ]])
        await update.message.reply_text(
            f"<code>{_esc(p['path'])}</code>\n"
            f"{_esc(host_str)} · {p['sessions']} sessions · last {dt}",
            parse_mode="HTML",
            reply_markup=keyboard
        )


@owner_only
async def cmd_new(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Usage: /new [user@host] /path/to/project [session-name]"""
    args = context.args
    if not args:
        await update.message.reply_text(
            "Usage: <code>/new [user@host] /path/to/project [name]</code>",
            parse_mode="HTML"
        )
        return

    # Parse: optional host, required path, optional name
    host = None
    idx  = 0
    if args[0] and not args[0].startswith("/") and "/" not in args[0].split("@")[-1][:3]:
        host = args[0] if "@" in args[0] else f"root@{args[0]}"
        idx  = 1

    if idx >= len(args):
        await update.message.reply_text("Missing path.")
        return

    path    = args[idx]
    name    = args[idx + 1] if idx + 1 < len(args) else os.path.basename(path.rstrip("/"))
    session = name.replace(" ", "-").lower()

    await update.message.reply_text(
        f"Provisioning <b>{session}</b> on <code>{host or 'local'}</code> at <code>{path}</code>...",
        parse_mode="HTML"
    )

    # Create Telegram topic first so we have thread_id for .mcp.json
    try:
        topic = await context.bot.create_forum_topic(
            chat_id=GROUP_CHAT_ID,
            name=session
        )
        thread_id = topic.message_thread_id
    except Exception as e:
        await update.message.reply_text(f"Topic creation failed: {e}")
        return

    # Create session + run Claude (with .mcp.json pointing to this thread)
    try:
        claude_cmd = provision_session(session, path, host, thread_id)
    except Exception as e:
        await update.message.reply_text(f"Error: {e}")
        return

    # Register
    key = (GROUP_CHAT_ID, thread_id)
    sessions[key] = session
    session_to_thread[session] = key
    line_counts[session] = len(tmux_capture(session, host))

    add_config({
        "thread_id": thread_id,
        "session":   session,
        "path":      path,
        "host":      host,
    })

    await context.bot.send_message(
        chat_id=GROUP_CHAT_ID,
        message_thread_id=thread_id,
        text=f"Session <b>{_esc(session)}</b> ready on <code>{_esc(host or 'local')}</code>\n"
             f"Path: <code>{_esc(path)}</code>\n"
             f"Running: <code>{_esc(claude_cmd)}</code>",
        parse_mode="HTML"
    )


@owner_only
async def cmd_claude(update: Update, context: ContextTypes.DEFAULT_TYPE):
    session, cfg = _session_from_update(update)
    if not session:
        await update.message.reply_text("No session mapped to this topic.")
        return

    path       = cfg.get("path", "/root")
    host       = cfg.get("host")
    session_id = latest_claude_session(path, host)
    claude_cmd = f"claude --resume {session_id}" if session_id else "claude"
    tmux_send(session, claude_cmd, host)
    await update.message.reply_text(
        f"<code>{_esc(claude_cmd)}</code>", parse_mode="HTML"
    )


@owner_only
async def cmd_restart(update: Update, context: ContextTypes.DEFAULT_TYPE):
    session, cfg = _session_from_update(update)
    if not session:
        await update.message.reply_text("No session mapped to this topic.")
        return

    host = cfg.get("host")

    tmux_send_ctrl(session, "C-c", host)
    await update.message.reply_text(
        "Ctrl+C sent — the loop will restart Claude automatically.", parse_mode="HTML"
    )


KNOWN_MODELS = {
    "opus":    "claude-opus-4-5",
    "sonnet":  "claude-sonnet-4-6",
    "haiku":   "claude-haiku-4-5-20251001",
}

@owner_only
async def cmd_model(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show or change the Claude model for this session.
    Usage: /model           — show current model
           /model sonnet    — switch to sonnet (alias or full model ID)
           /model default   — remove model override (use Claude's default)
    """
    session, cfg = _session_from_update(update)
    if not session:
        await update.message.reply_text("No session mapped to this topic.")
        return

    args = context.args or []
    current = cfg.get("model") or "(default)"

    if not args:
        available = "\n".join(f"• <code>{k}</code> → <code>{v}</code>" for k, v in KNOWN_MODELS.items())
        await update.message.reply_text(
            f"<b>Current model:</b> <code>{_esc(current)}</code>\n\n"
            f"<b>Shortcuts:</b>\n{available}\n\n"
            f"Usage: <code>/model sonnet</code> | <code>/model default</code> | <code>/model claude-opus-4-5</code>",
            parse_mode="HTML"
        )
        return

    raw = args[0].strip()

    if raw == "default":
        new_model = None
        label = "(default)"
    else:
        new_model = KNOWN_MODELS.get(raw, raw)  # expand alias or use as-is
        label = new_model

    # Update config
    configs = load_config()
    for c in configs:
        if c["session"] == session:
            if new_model:
                c["model"] = new_model
            else:
                c.pop("model", None)
            break
    save_config(configs)

    # Restart the session with new model
    host = cfg.get("host")
    path = cfg.get("path", "/root")
    tmux_send_ctrl(session, "C-c", host)
    import asyncio as _asyncio
    await _asyncio.sleep(1)
    provision_session(session, path, host, model=new_model)

    await update.message.reply_text(
        f"Model set to <code>{_esc(label)}</code> — session restarted.",
        parse_mode="HTML"
    )


@owner_only
async def cmd_upgrade(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Upgrade Claude Code on all hosts, then restart all sessions."""
    await update.message.reply_text("Upgrading Claude Code on all hosts…", parse_mode="HTML")

    hosts = list({cfg.get("host") or None for cfg in get_configs()})
    results = []

    for host in hosts:
        label = host or "local"
        # claude update works for both npm and standalone installs
        r = run_cmd(["claude", "update"], host)
        output = (r.stdout + r.stderr).strip()[-300:] or "(no output)"
        results.append(f"<b>{_esc(label)}</b>:\n<pre>{_esc(output)}</pre>")

    await update.message.reply_text("\n\n".join(results), parse_mode="HTML")

    # Restart all sessions to pick up new version
    script = os.path.join(os.path.dirname(__file__), "restart-all-sessions.sh")
    subprocess.run([script], capture_output=True)
    await update.message.reply_text("All sessions restarted.", parse_mode="HTML")


@owner_only
async def cmd_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Send a link to another session's topic. Usage: /link [session-name]
    Without args: shows links to all sessions."""
    clean_chat = str(GROUP_CHAT_ID).replace("-100", "")
    args = context.args or []

    if args:
        name = args[0]
        cfg = next((c for c in get_configs() if c["session"] == name), None)
        if not cfg:
            await update.message.reply_text(f"Session <code>{_esc(name)}</code> not found.", parse_mode="HTML")
            return
        thread_id = cfg["thread_id"]
        url = f"https://t.me/c/{clean_chat}/{thread_id}"
        await update.message.reply_text(
            f"<b>{_esc(name)}</b>: {url}", parse_mode="HTML"
        )
    else:
        lines = []
        for cfg in get_configs():
            url = f"https://t.me/c/{clean_chat}/{cfg['thread_id']}"
            host = f" ({cfg['host']})" if cfg.get("host") else ""
            lines.append(f"• <b>{_esc(cfg['session'])}</b>{_esc(host)}: {url}")
        await update.message.reply_text("\n".join(lines) or "No sessions.", parse_mode="HTML")


@owner_only
async def cmd_restart_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Restart all Claude sessions across all hosts. Useful after settings changes."""
    filter_host = (context.args or [None])[0]
    label = f" on {filter_host}" if filter_host else " (all hosts)"
    await update.message.reply_text(f"Restarting all sessions{label}…", parse_mode="HTML")

    script = os.path.join(os.path.dirname(__file__), "restart-all-sessions.sh")
    args = [script]
    if filter_host:
        args.append(filter_host)

    r = subprocess.run(args, capture_output=True, text=True)
    output = (r.stdout + r.stderr).strip()
    await update.message.reply_text(f"<pre>{_esc(output)}</pre>", parse_mode="HTML")


@owner_only
async def cmd_mcp_add(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Usage: /mcp-add <name> <binary> [args...] [KEY=VAL...]
    Resolves full binary path on the target host, adds MCP via claude mcp add-json, restarts Claude."""
    session, cfg = _session_from_update(update)
    if not session:
        await update.message.reply_text("No session mapped to this topic.")
        return

    args = context.args or []
    if len(args) < 2:
        await update.message.reply_text(
            "Usage: <code>/mcp-add &lt;name&gt; &lt;binary&gt; [args...] [KEY=VAL...]</code>\n"
            "Example: <code>/mcp-add stitch stitch-mcp proxy STITCH_API_KEY=abc123</code>",
            parse_mode="HTML"
        )
        return

    host = cfg.get("host")
    path = cfg["path"]
    mcp_name = args[0]
    binary   = args[1]
    rest     = args[2:]

    mcp_args = [a for a in rest if "=" not in a]
    env_pairs = [a for a in rest if "=" in a]

    # Resolve full binary path on target host
    r = run_cmd(["bash", "-c",
        f"which '{binary}' 2>/dev/null || find /root/.nvm /usr/local/bin -name '{binary}' 2>/dev/null | head -1"
    ], host)
    full_bin = r.stdout.strip()
    if not full_bin:
        await update.message.reply_text(
            f"Could not find <code>{_esc(binary)}</code> on {_esc(host or 'local')}.",
            parse_mode="HTML"
        )
        return

    # Build JSON config
    import json as _json
    env_dict = {}
    for pair in env_pairs:
        k, _, v = pair.partition("=")
        env_dict[k] = v
    mcp_cfg = {"command": full_bin, "args": mcp_args, "env": env_dict}
    mcp_json = _json.dumps(mcp_cfg)

    # Remove existing + add new
    run_cmd(["bash", "-c", f"cd '{path}' && claude mcp remove '{mcp_name}' -s local 2>/dev/null || true"], host)
    r2 = run_cmd(["bash", "-c", f"cd '{path}' && claude mcp add-json '{mcp_name}' '{mcp_json}' -s local"], host)
    if r2.returncode != 0:
        await update.message.reply_text(
            f"<b>Failed:</b> <pre>{_esc(r2.stderr or r2.stdout)}</pre>", parse_mode="HTML"
        )
        return

    # Restart Claude
    tmux_send(session, "q", host)
    await update.message.reply_text(
        f"MCP <code>{_esc(mcp_name)}</code> added (<code>{_esc(full_bin)}</code>).\n"
        f"Claude restarting…",
        parse_mode="HTML"
    )


@owner_only
async def cmd_kill(update: Update, context: ContextTypes.DEFAULT_TYPE):
    session, cfg = _session_from_update(update)
    if not session:
        await update.message.reply_text("No session mapped to this topic.")
        return
    tmux_send_ctrl(session, "C-c", cfg.get("host"))
    await update.message.reply_text(f"Ctrl+C → <b>{_esc(session)}</b>", parse_mode="HTML")


@owner_only
async def cmd_snap(update: Update, context: ContextTypes.DEFAULT_TYPE):
    session, cfg = _session_from_update(update)
    if not session:
        await update.message.reply_text("No session attached.")
        return
    lines  = tmux_capture(session, cfg.get("host"))
    output = "\n".join(lines[-50:])
    await update.message.reply_text(
        f"<pre>{_esc(output)}</pre>", parse_mode="HTML"
    )


@owner_only
async def cmd_sessions(update: Update, context: ContextTypes.DEFAULT_TYPE):
    configs = get_configs()
    if not configs:
        await update.message.reply_text("No sessions configured.")
        return
    lines = [
        f"• <b>{_esc(c['session'])}</b> — {_esc(c.get('host') or 'local')}:{_esc(c['path'])}"
        for c in configs
    ]
    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


AGENT_SKIP = {"relay", "tgbot", "clawdbot", "cliproxy", "claude-runner", "2"}

def _load_teams() -> list[dict]:
    """Return list of team configs from ~/.claude/teams/*/config.json"""
    import glob as _glob
    teams = []
    for path in _glob.glob(os.path.expanduser("~/.claude/teams/*/config.json")):
        try:
            with open(path) as f:
                teams.append(json.load(f))
        except Exception:
            pass
    return teams


def _active_panes() -> dict[str, str]:
    """Return mapping of pane_id -> last few lines from all active tmux panes."""
    r = subprocess.run(
        ["tmux", "list-panes", "-a", "-F", "#{pane_id}"],
        capture_output=True, text=True
    )
    return {p.strip() for p in r.stdout.splitlines() if p.strip()}


def _capture_pane_id(pane_id: str) -> list[str]:
    """Capture output from a tmux pane by global pane ID (e.g. %4)."""
    r = subprocess.run(
        ["tmux", "capture-pane", "-p", "-S", "-", "-t", pane_id],
        capture_output=True, text=True
    )
    lines = r.stdout.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


@owner_only
async def cmd_agents(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show Claude team agents with live snapshots from their tmux panes."""
    teams   = _load_teams()
    active  = _active_panes()

    if not teams:
        await update.message.reply_text("No Claude teams found in ~/.claude/teams/")
        return

    for team in teams:
        name    = team.get("name") or team.get("leadAgentId", "unknown")
        members = team.get("members", [])

        header = f"<b>Team: {_esc(name)}</b> ({len(members)} agents)"
        await update.message.reply_text(header, parse_mode="HTML")

        for m in members:
            agent_name = m.get("name", m.get("agentId", "?"))
            pane_id    = m.get("tmuxPaneId", "")
            agent_type = m.get("agentType", "")

            if pane_id and pane_id in active:
                lines  = _capture_pane_id(pane_id)
                clean  = [ANSI_RE.sub("", l).strip() for l in lines[-30:]]
                clean  = [l for l in clean if l][-5:]
                status = "\n".join(clean) or "(empty)"
                state  = "🟢"
            elif pane_id == "in-process":
                status = "(in-process, no pane)"
                state  = "🔵"
            elif pane_id:
                status = "(pane gone)"
                state  = "⚫"
            else:
                status = "(not started)"
                state  = "⚪"

            await update.message.reply_text(
                f"{state} <b>{_esc(agent_name)}</b> <i>{_esc(agent_type)}</i>\n"
                + (f"<pre>{_esc(status)}</pre>" if pane_id and pane_id in active else f"<i>{_esc(status)}</i>"),
                parse_mode="HTML",
            )


@owner_only
async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not sessions:
        await update.message.reply_text("No active mappings.")
        return
    lines = [
        f"thread <code>{tid}</code> → <b>{_esc(s)}</b>"
        for (_, tid), s in sessions.items()
    ]
    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


def _all_tmux_sessions(host: str | None = None) -> list[str]:
    """Return all running tmux session names on a host."""
    r = run_cmd(["tmux", "list-sessions", "-F", "#{session_name}"], host)
    if r.returncode != 0:
        return []
    return [s.strip() for s in r.stdout.splitlines() if s.strip()]


@owner_only
async def cmd_switch(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Switch current topic to route messages to any tmux session (including team agents).
    Usage: /switch            — show all sessions as buttons
           /switch <session>  — switch this topic to that session
    """
    chat_id   = update.effective_chat.id
    thread_id = update.message.message_thread_id

    if not thread_id:
        await update.message.reply_text("Must be used inside a topic.")
        return

    current = sessions.get((chat_id, thread_id), "—")
    configs = get_configs()
    registered = {c["session"] for c in configs}

    # Get all running tmux sessions (local only for now)
    all_tmux = _all_tmux_sessions()
    # Exclude internal/system sessions
    SKIP = {"relay", "tgbot", "clawdbot", "cliproxy", "claude-runner", "2"}
    all_tmux = [s for s in all_tmux if s not in SKIP]

    if not context.args:
        if not all_tmux:
            await update.message.reply_text("No tmux sessions found.")
            return

        # Split into registered sessions and unregistered agents
        reg   = [s for s in all_tmux if s in registered]
        agents = [s for s in all_tmux if s not in registered]

        def make_btn(name: str) -> InlineKeyboardButton:
            label = ("✓ " if name == current else "") + name
            return InlineKeyboardButton(label, callback_data=f"switch:{thread_id}:{name}")

        rows = []
        if reg:
            rows += [reg[i:i+2] for i in range(0, len(reg), 2)]
        if agents:
            rows.append(["── agents ──".center(12)])  # separator label (non-functional)
            rows += [agents[i:i+2] for i in range(0, len(agents), 2)]

        # Build keyboard — skip the separator row (no callback_data for it)
        kb_rows = []
        for row in rows:
            if row == ["── agents ──".center(12)]:
                # Use a disabled-looking button as separator
                kb_rows.append([InlineKeyboardButton("· · · agents · · ·", callback_data="noop")])
            else:
                kb_rows.append([make_btn(n) for n in row])

        keyboard = InlineKeyboardMarkup(kb_rows)
        await update.message.reply_text(
            f"Active: <b>{_esc(current)}</b>\nSwitch to:",
            parse_mode="HTML",
            reply_markup=keyboard,
        )
        return

    target = context.args[0]
    if not tmux_exists(target):
        await update.message.reply_text(f"Session <code>{_esc(target)}</code> not running.", parse_mode="HTML")
        return

    cfg = next((c for c in configs if c["session"] == target), {})
    _do_switch(chat_id, thread_id, target, cfg)
    await update.message.reply_text(f"Switched to <b>{_esc(target)}</b>.", parse_mode="HTML")


def _do_switch(chat_id: int, thread_id: int, session: str, cfg: dict):
    """Update in-memory routing so this topic now talks to `session`."""
    old = sessions.get((chat_id, thread_id))
    if old and session_to_thread.get(old) == (chat_id, thread_id):
        del session_to_thread[old]
    sessions[(chat_id, thread_id)] = session
    session_to_thread[session] = (chat_id, thread_id)


@owner_only
async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.data == "noop":
        return

    # Button press from Claude's send_message buttons=[...]
    if query.data.startswith("btn:"):
        _, thread_id_str, label = query.data.split(":", 2)
        thread_id = int(thread_id_str)
        user = query.from_user.first_name or "User"
        import time as _time
        # Look up host for this thread (handles remote sessions)
        cfg  = next((c for c in get_configs() if c.get("thread_id") == thread_id), {})
        host = cfg.get("host")
        entry = {
            "text": label,
            "user": user,
            "message_id": int(_time.time() * 1000),
            "thread_id": thread_id,
            "chat_id": query.message.chat_id,
            "ts": _time.time(),
        }
        write_queue(thread_id, entry, host)
        # Remove buttons from the message so it can't be clicked twice
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass
        # Echo the selection back into the chat so it's visible
        try:
            await query.message.reply_text(
                f"▶ {label}",
                message_thread_id=thread_id,
            )
        except Exception:
            pass
        return

    if query.data.startswith("switch:"):
        _, thread_id_str, target = query.data.split(":", 2)
        thread_id = int(thread_id_str)
        chat_id   = query.message.chat_id
        cfg = next((c for c in get_configs() if c["session"] == target), None)
        if cfg:
            _do_switch(chat_id, thread_id, target, cfg)
            try:
                await query.edit_message_text(
                    f"Switched to <b>{_esc(target)}</b>.", parse_mode="HTML"
                )
            except Exception:
                pass
        return

    if not query.data.startswith("connect:"):
        return

    payload     = query.data[len("connect:"):]
    host_raw, path = payload.split("|", 1)
    host        = host_raw or None
    name        = os.path.basename(path.rstrip("/"))
    session     = name.replace(" ", "-").lower()

    await query.edit_message_text(
        f"Provisioning <b>{_esc(session)}</b>...", parse_mode="HTML"
    )

    try:
        topic = await context.bot.create_forum_topic(
            chat_id=GROUP_CHAT_ID, name=session
        )
        thread_id = topic.message_thread_id
    except Exception as e:
        await query.edit_message_text(
            f"Topic failed: {_esc(str(e))}", parse_mode="HTML"
        )
        return

    try:
        claude_cmd = provision_session(session, path, host, thread_id)
    except Exception as e:
        await query.edit_message_text(f"Error: {_esc(str(e))}", parse_mode="HTML")
        return

    key = (GROUP_CHAT_ID, thread_id)
    sessions[key] = session
    session_to_thread[session] = key
    line_counts[session] = len(tmux_capture(session, host))

    add_config({"thread_id": thread_id, "session": session, "path": path, "host": host})

    await query.edit_message_text(
        f"✓ <b>{_esc(session)}</b> connected\n"
        f"<code>{_esc(claude_cmd)}</code>",
        parse_mode="HTML"
    )
    await context.bot.send_message(
        chat_id=GROUP_CHAT_ID,
        message_thread_id=thread_id,
        text=f"Session <b>{_esc(session)}</b> ready\n"
             f"Path: <code>{_esc(path)}</code>\n"
             f"Running: <code>{_esc(claude_cmd)}</code>",
        parse_mode="HTML"
    )


def queue_file(thread_id: int) -> str:
    return f"/tmp/tg-queue-{thread_id}.jsonl"


def write_queue(thread_id: int, message: dict, host: str | None = None):
    """Write incoming message to queue file for MCP server to consume."""
    import time
    entry = json.dumps({**message, "ts": time.time()})
    qf = queue_file(thread_id)
    if host:
        # Pipe via stdin to avoid SSH multi-arg quoting issues
        ssh = ssh_prefix(host) + [f"cat >> {qf}"]
        subprocess.run(ssh, input=entry + "\n", text=True, capture_output=True)
    else:
        with open(qf, "a") as f:
            f.write(entry + "\n")


@owner_only
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id   = update.effective_chat.id
    thread_id = update.message.message_thread_id

    logger.info(f"Message: chat={chat_id} thread={thread_id} text={update.message.text!r}")

    if not thread_id:
        return

    session = sessions.get((chat_id, thread_id))
    if not session:
        return

    cfg  = next((c for c in get_configs() if c.get("session") == session), {})
    host = cfg.get("host")
    path = cfg.get("path", "/root")

    # Check if session has .mcp.json (local or remote)
    mcp_json = f"{path}/.mcp.json"
    if host:
        has_mcp = run_cmd(["test", "-f", mcp_json], host).returncode == 0
    else:
        has_mcp = os.path.exists(mcp_json)

    text = update.message.text or update.message.caption or ""
    photo_path = None

    if update.message.photo:
        # Download highest-res photo to /tmp/ with retry
        photo = update.message.photo[-1]
        local_path = f"/tmp/tg-photo-{update.message.message_id}.jpg"
        downloaded = False
        for attempt in range(3):
            try:
                tg_file = await context.bot.get_file(photo.file_id)
                await tg_file.download_to_drive(local_path)
                downloaded = True
                logger.info(f"Downloaded photo to {local_path}")
                break
            except Exception as e:
                logger.warning(f"Photo download attempt {attempt+1} failed: {e}")
                if attempt < 2:
                    await asyncio.sleep(2)

        if downloaded:
            # For remote sessions, SCP the photo to the remote host
            if host:
                scp = subprocess.run(
                    ["scp", "-o", "StrictHostKeyChecking=no", local_path, f"{host}:{local_path}"],
                    capture_output=True, text=True
                )
                if scp.returncode == 0:
                    photo_path = local_path
                    logger.info(f"SCP'd photo to {host}:{local_path}")
                else:
                    logger.warning(f"SCP failed: {scp.stderr} — using local path")
                    photo_path = local_path
            else:
                photo_path = local_path

            caption = f" {text}" if text else ""
            text = f"[Photo: {photo_path}]{caption}"
        else:
            text = f"[Photo: failed to download]{(' ' + text) if text else ''}"

    if has_mcp:
        entry = {
            "text":       text,
            "user":       update.effective_user.first_name if update.effective_user else "user",
            "message_id": update.message.message_id,
            "thread_id":  thread_id,
            "chat_id":    chat_id,
        }
        if photo_path:
            entry["photo_path"] = photo_path
        write_queue(thread_id, entry, host)
        last_user_sent[session] = time.time()
        logger.info(f"Queued message for MCP session '{session}' (thread {thread_id})")
        if not update.message.photo:
            tmux_send(session, text, host)
    else:
        # No MCP — raw tmux passthrough (text only)
        if not update.message.photo:
            tmux_send(session, text, host)


# ─── main ─────────────────────────────────────────────────────────────────────

async def debug_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Log every single update for debugging."""
    uid = update.effective_user.id if update.effective_user else None
    chat = update.effective_chat.id if update.effective_chat else None
    msg = update.message
    thread = msg.message_thread_id if msg else None
    text = msg.text if msg else "(no text)"
    logger.info(f"DEBUG UPDATE: user_id={uid} chat={chat} thread={thread} text={text!r}")


async def post_init(app: Application):
    load_sessions()
    app.job_queue.run_repeating(poll_output, interval=POLL_INTERVAL, first=2)


def main():
    if not TOKEN:
        raise ValueError("TELEGRAM_BOT_TOKEN not set")

    app = Application.builder().token(TOKEN).post_init(post_init).build()

    # Debug: log everything before any filtering
    app.add_handler(MessageHandler(filters.ALL, debug_all), group=-1)

    app.add_handler(CommandHandler("start",   cmd_start))
    app.add_handler(CommandHandler("new",        cmd_new))
    app.add_handler(CommandHandler("discover",   cmd_discover))
    app.add_handler(CommandHandler("addhost",    cmd_addhost))
    app.add_handler(CommandHandler("removehost", cmd_removehost))
    app.add_handler(CommandHandler("claude",  cmd_claude))
    app.add_handler(CommandHandler("restart",     cmd_restart))
    app.add_handler(CommandHandler("restart_all", cmd_restart_all))
    app.add_handler(CommandHandler("model",       cmd_model))
    app.add_handler(CommandHandler("upgrade",     cmd_upgrade))
    app.add_handler(CommandHandler("link",        cmd_link))
    app.add_handler(CommandHandler("mcp_add",     cmd_mcp_add))
    app.add_handler(CommandHandler("kill",     cmd_kill))
    app.add_handler(CommandHandler("snap",    cmd_snap))
    app.add_handler(CommandHandler("sessions",cmd_sessions))
    app.add_handler(CommandHandler("status",  cmd_status))
    app.add_handler(CommandHandler("switch",  cmd_switch))
    app.add_handler(CommandHandler("agents",  cmd_agents))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler((filters.TEXT | filters.PHOTO) & ~filters.COMMAND, handle_message))

    logger.info("Bot starting...")
    if WEBHOOK_URL:
        webhook_full = f"{WEBHOOK_URL}/tg"
        logger.info(f"Starting in webhook mode: {webhook_full} → localhost:{WEBHOOK_PORT}")
        kwargs = dict(
            webhook_url          = webhook_full,
            listen               = "127.0.0.1",
            port                 = WEBHOOK_PORT,
            url_path             = "/tg",
            drop_pending_updates = True,
        )
        if WEBHOOK_CERT:
            kwargs["cert"] = WEBHOOK_CERT   # uploaded to Telegram for self-signed cert verification
        app.run_webhook(**kwargs)
    else:
        app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
