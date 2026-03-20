# tmux-telegram

Control Claude Code from Telegram — no SSH, no terminal babysitting.

Send a message from your phone. Claude thinks inside the project directory. Replies with formatted code, logs, diffs — right back in the same Telegram topic.

```
Phone
  ↓
Telegram topic (one per project)
  ↓
tmux-telegram bot (single getUpdates long-poll)
  ↓
/tmp/tg-queue-{THREAD_ID}.jsonl
  ↓
MCP server · mcp-telegram/ (tails queue file)
  ↓
Claude Code (running in project directory)
  ↓
send_message → Telegram topic
  ↓
Phone
```

---

## How it works

Telegram's [forum topics](https://telegram.org/blog/topics-in-groups-collectible-usernames) give each thread a unique `message_thread_id`. This repo uses that ID as the key for everything:

- **One topic = one project.** Each Telegram topic maps to exactly one tmux session running Claude Code in a specific directory. Messages stay isolated — no cross-talk between projects.
- **One long-poll, many consumers.** Telegram returns `409 Conflict` if two processes call `getUpdates` with the same bot token. The routing bot (`bot.py`) holds the single long-poll and writes each incoming message to a queue file named after the topic's thread ID: `/tmp/tg-queue-{THREAD_ID}.jsonl`. Each MCP server instance reads only its own file — no conflicts, no duplicated API calls.
- **Queue files as the handoff.** The queue file decouples the routing bot from Claude's lifecycle. If Claude restarts mid-session, the routing bot keeps running and the queue keeps filling. When Claude comes back up, the MCP server resumes tailing from where it left off.
- **`sessions.json` as the source of truth.** The mapping of `thread_id → session name → project path → host` lives in `sessions.json`. This is what makes the whole routing table work — add a line and the bot knows which tmux session to write to and which queue file to update.

---

## What's in this repo

| Path | What it is |
|------|-----------|
| `bot.py` | Routing bot — runs once, globally. Holds the Telegram long-poll, fans messages to queue files, provisions tmux sessions. |
| `mcp-telegram/` | MCP server — one instance per project. Tails its queue file and delivers messages to Claude as `notifications/claude/channel` events. |
| `CLAUDE_TEMPLATE.md` | Paste into your project's `CLAUDE.md` to tell Claude how to behave on Telegram. |

---

## Prerequisites

- Python 3.10+ and `pip`
- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- `tmux`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Telegram **Supergroup** with **Topics** enabled
- SSH key auth for any remote hosts (no password prompts)

> **Critical: bun must be in system PATH**
>
> Claude Code spawns MCP servers with a minimal environment. If bun is only in `~/.bun/bin` the MCP server silently fails to start.
>
> Fix:
> ```bash
> sudo ln -sf ~/.bun/bin/bun /usr/local/bin/bun
> which bun  # should return /usr/local/bin/bun
> ```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/shaike1/tmux-telegram
cd tmux-telegram
pip install python-telegram-bot[job-queue]==21.6
```

### 2. Create your Telegram bot

- Open [@BotFather](https://t.me/BotFather), send `/newbot`, follow the steps, copy the token
- Disable privacy mode: BotFather → `/mybots` → your bot → **Bot Settings → Group Privacy → Turn off**

### 3. Set up your Supergroup

- Create a Telegram group → Settings → **Topics: Enable**
- Add your bot as **Admin** with "Manage Topics" permission

### 4. Configure the routing bot

```bash
cp .env.example .env
cp sessions.example.json sessions.json
cp hosts.example.json hosts.json
```

Edit `.env`:
```env
TELEGRAM_BOT_TOKEN=your_token_here
OWNER_ID=your_telegram_user_id
GROUP_CHAT_ID=-1001234567890
```

To find your `OWNER_ID`, send `/start` to [@userinfobot](https://t.me/userinfobot).
To find `GROUP_CHAT_ID`, add the bot to your group and call `getUpdates` — look for `chat.id` (a large negative number).

### 5. Start the routing bot

```bash
python bot.py
```

Or as a systemd service (recommended):

```ini
# /etc/systemd/system/tmux-telegram.service
[Unit]
Description=tmux-telegram routing bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/tmux-telegram
EnvironmentFile=/root/tmux-telegram/.env
ExecStart=/usr/bin/python3 /root/tmux-telegram/bot.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable tmux-telegram
systemctl start tmux-telegram
journalctl -u tmux-telegram -f
```

### 6. Add the MCP server to a project

In your project folder, create `.mcp.json`:
```json
{
  "mcpServers": {
    "telegram": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/tmux-telegram/mcp-telegram", "--silent", "start"],
      "env": {
        "TELEGRAM_THREAD_ID": "YOUR_THREAD_ID"
      }
    }
  }
}
```

Replace `/path/to/tmux-telegram` with where you cloned this repo. `TELEGRAM_THREAD_ID` is the `message_thread_id` for this project's Telegram topic (run `getUpdates` and look in the message object).

The MCP server reads its credentials from `~/.claude/channels/telegram/.env`:
```env
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_CHAT_ID=-1001234567890
```

### 7. Add CLAUDE.md to your project

Copy `CLAUDE_TEMPLATE.md` to your project root as `CLAUDE.md` (or append it to an existing one). This tells Claude to respond via `send_message` instead of the terminal.

### 8. Launch Claude

```bash
cd /your/project
claude
```

Claude loads the MCP server automatically, connects to the Telegram topic, and starts listening. Send a message — you'll see the typing indicator, then a reply.

---

## Bot commands

All commands are restricted to `OWNER_ID`.

### Provisioning

| Command | Description |
|---------|-------------|
| `/new [user@host] /path/to/project [name]` | Create a topic, tmux session, and `.mcp.json`. Host optional (defaults to local). Name optional (defaults to dir name). |
| `/discover` | Scan all known hosts for Claude project history not yet connected to a topic. Inline buttons to connect each one. |
| `/addhost [user@]host` | Register a host for `/discover` scans. Tests SSH connectivity first. |
| `/removehost [user@]host` | Remove a host. With no args, lists current hosts. |

### Session control (send from within a topic)

| Command | Description |
|---------|-------------|
| `/claude` | Start or resume Claude in this topic's tmux session |
| `/restart` | Ctrl+C then re-launch Claude (resumes latest session) |
| `/kill` | Send Ctrl+C to the session |
| `/snap` | Snapshot the last 50 lines of the tmux pane |

### Info

| Command | Description |
|---------|-------------|
| `/sessions` | List all configured sessions |
| `/status` | Show topic↔session mappings |

---

## MCP tools available to Claude

| Tool | Description |
|------|-------------|
| `send_message` | Send text to the topic (HTML: `<b>`, `<i>`, `<code>`, `<pre>`) |
| `edit_message` | Edit a previously sent message |
| `typing` | Show typing indicator (~5s) |
| `fetch_messages` | Get recent message history from this session |

---

## Multi-server setup

`sessions.json` supports remote hosts via SSH:

```json
[
  {
    "thread_id": 42,
    "session": "myproject",
    "path": "/root/myproject",
    "host": null
  },
  {
    "thread_id": 43,
    "session": "remote-project",
    "path": "/root/remote-project",
    "host": "root@your-server-ip"
  }
]
```

The routing bot SSHes to write queue files and provision sessions on remote hosts. SSH key auth required (no password prompts).

---

## Troubleshooting

### MCP server fails to start (`telegram · ✘ failed`)

**Cause:** `bun` is not in the system PATH Claude uses when spawning MCP servers.

**Fix:**
```bash
sudo ln -sf ~/.bun/bin/bun /usr/local/bin/bun
which bun  # should show /usr/local/bin/bun
```

### 409 Conflict errors

**Cause:** Two processes are calling `getUpdates` with the same token.

**Fix:** Only the routing bot (`bot.py`) should poll. The MCP server reads queue files only — it never calls `getUpdates`.

### Messages not arriving

1. Is the routing bot running? `systemctl status tmux-telegram` or `tmux ls`
2. Does the queue file exist? `ls /tmp/tg-queue-*.jsonl`
3. Is `TELEGRAM_THREAD_ID` in `.mcp.json` correct?
4. Did you restart Claude after changing `.mcp.json`?

---

## Security

- Only `OWNER_ID` can issue commands or have messages routed — everyone else is silently ignored
- Keep `.env` private — never commit it (it's in `.gitignore`)
- Use a private Telegram group
- Queue files in `/tmp/` are ephemeral and local to each machine

---

## License

MIT
