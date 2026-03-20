import asyncio
import os
import json
import subprocess
import logging
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

POLL_INTERVAL     = 2
MAX_LINES         = 2000
CONFIG_FILE       = os.path.join(os.path.dirname(__file__), "sessions.json")
HOSTS_FILE        = os.path.join(os.path.dirname(__file__), "hosts.json")

# Runtime state
sessions: dict[tuple[int, int], str] = {}        # (chat_id, thread_id) -> session_name
session_to_thread: dict[str, tuple[int, int]] = {}
line_counts: dict[str, int] = {}

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
                    "TELEGRAM_THREAD_ID": str(thread_id)
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


def provision_session(session: str, path: str, host: str | None = None, thread_id: int | None = None):
    """Ensure tmux session exists at path, running Claude (resumed if possible)."""
    # Create project folder if needed
    run_cmd(["mkdir", "-p", path], host)

    # Write .mcp.json so Claude loads the Telegram channel
    if thread_id:
        write_mcp_json(path, thread_id, host)

    if not tmux_exists(session, host):
        if host:
            run_cmd(["tmux", "new-session", "-d", "-s", session, "-c", path], host)
        else:
            subprocess.run(["tmux", "new-session", "-d", "-s", session, "-c", path],
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
    loop_cmd = (
        f"while true; do "
        f"IS_SANDBOX=1 {claude_bin} --dangerously-skip-permissions --remote-control --continue "
        f"|| IS_SANDBOX=1 {claude_bin} --dangerously-skip-permissions --remote-control; "
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

async def poll_output(context: ContextTypes.DEFAULT_TYPE):
    configs = {cfg["session"]: cfg for cfg in get_configs()}

    for (chat_id, thread_id), session in list(sessions.items()):
        cfg  = configs.get(session, {})
        host = cfg.get("host")
        path = cfg.get("path", "/root")

        try:
            if not tmux_exists(session, host):
                logger.warning(f"Session '{session}' gone — reprovisioning")
                provision_session(session, path, host)
                line_counts[session] = len(tmux_capture(session, host))
                continue

            # Skip poll_output for MCP sessions — Claude sends replies via send_message tool
            mcp_json = f"{path}/.mcp.json"
            has_mcp = (run_cmd(["test", "-f", mcp_json], host).returncode == 0) if host else os.path.exists(mcp_json)
            if has_mcp:
                line_counts[session] = len(tmux_capture(session, host))
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
        "/kill — send Ctrl+C\n"
        "/snap — snapshot last 50 lines\n\n"
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


@owner_only
async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

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

    if has_mcp:
        write_queue(thread_id, {
            "text":       update.message.text,
            "user":       update.effective_user.first_name if update.effective_user else "user",
            "message_id": update.message.message_id,
            "thread_id":  thread_id,
            "chat_id":    chat_id,
        }, host)
        logger.info(f"Queued message for MCP session '{session}' (thread {thread_id})")
        tmux_send(session, update.message.text, host)
    else:
        # No MCP — raw tmux passthrough
        tmux_send(session, update.message.text, host)


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
    app.add_handler(CommandHandler("restart", cmd_restart))
    app.add_handler(CommandHandler("kill",    cmd_kill))
    app.add_handler(CommandHandler("snap",    cmd_snap))
    app.add_handler(CommandHandler("sessions",cmd_sessions))
    app.add_handler(CommandHandler("status",  cmd_status))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Bot starting...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
