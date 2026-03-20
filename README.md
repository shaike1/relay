# tmux-telegram

A Telegram→Claude Code bridge that routes messages from Telegram forum topics to Claude Code tmux sessions. Companion to [github.com/shaike1/claude-telegram-channel](https://github.com/shaike1/claude-telegram-channel).

Send a message from your phone → Claude thinks in the project directory → replies formatted in the same Telegram topic. No SSH. No terminal babysitting.

---

## What it does

**One Telegram topic per project.** Each topic is wired to a tmux session running Claude Code in that project's directory. The bot holds a single `getUpdates` long-poll (avoiding Telegram 409 Conflict errors) and fans messages out to per-topic queue files. The MCP server in each Claude session reads its queue file and delivers messages as `notifications/claude/channel` events.

```
Telegram topic (one per project)
  ↓
tmux-telegram bot (single getUpdates long-poll)
  ↓
/tmp/tg-queue-{THREAD_ID}.jsonl
  ↓
claude-telegram-channel MCP server (tails queue file)
  ↓
Claude Code (running in project directory)
  ↓
send_message tool → Telegram topic
```

---

## Features

- **Multi-server SSH support** — manage projects on remote hosts alongside local ones
- **Auto-provision new sessions** — `/new` creates a Telegram topic, tmux session, and `.mcp.json` in one command
- **`/discover`** — scan all servers for existing Claude project history not yet wired to a topic, with one-tap connect buttons
- **Auto-resume on restart** — Claude always resumes the latest session via `claude --resume`
- **One topic per project** — clean separation, no cross-talk
- **Persistent config** — sessions survive bot restarts via `sessions.json`

---

## Prerequisites

- Python 3.10+
- `python-telegram-bot[job-queue]` v21
- `tmux`
- SSH key auth for any remote hosts (no password prompts)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Telegram Supergroup with Topics enabled
- The [claude-telegram-channel](https://github.com/shaike1/claude-telegram-channel) MCP server (for Claude to reply via Telegram)

---

## Install

```bash
git clone https://github.com/shaike1/tmux-telegram
cd tmux-telegram
pip install python-telegram-bot[job-queue]==21.6
```

Copy the example config files:

```bash
cp .env.example .env
cp sessions.example.json sessions.json   # or start fresh with []
cp hosts.example.json hosts.json         # or start fresh with []
```

Edit `.env` with your values:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
OWNER_ID=your_telegram_user_id
GROUP_CHAT_ID=-1001234567890
```

To find your `OWNER_ID`, send `/start` to [@userinfobot](https://t.me/userinfobot). For `GROUP_CHAT_ID`, add the bot to your supergroup and call `getUpdates` — look for `chat.id` (a large negative number).

---

## Configuration

### sessions.json

Each entry maps a Telegram topic to a tmux session:

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

- `thread_id` — Telegram topic (forum thread) ID
- `session` — tmux session name
- `path` — project directory on the host
- `host` — SSH target (`user@host`) or `null` for local

### hosts.json

List of SSH hosts to include in `/discover` scans:

```json
["root@your-server-ip"]
```

Hosts already referenced in `sessions.json` are scanned automatically. This file is for additional hosts you want to include.

---

## Bot commands

All commands are restricted to the `OWNER_ID` set in `.env`.

### Provisioning

| Command | Description |
|---------|-------------|
| `/new [user@host] /path/to/project [name]` | Create a new topic, tmux session, and `.mcp.json`. Host is optional (defaults to local). Name is optional (defaults to directory basename). |
| `/discover` | Scan all known hosts for Claude project history not yet connected to a topic. Shows inline buttons to connect each orphan. |
| `/addhost [user@]host` | Register a host for `/discover` scans. Tests SSH connectivity first. |
| `/removehost [user@]host` | Remove a host from the registered list. With no args, lists current hosts. |

### Session control (send from within a topic)

| Command | Description |
|---------|-------------|
| `/claude` | Start or resume Claude in this topic's tmux session |
| `/restart` | Send Ctrl+C then re-launch Claude (resume latest session) |
| `/kill` | Send Ctrl+C to the session |
| `/snap` | Snapshot the last 50 lines of the tmux pane |

### Info

| Command | Description |
|---------|-------------|
| `/sessions` | List all configured sessions with host and path |
| `/status` | Show topic↔session mappings (thread ID → session name) |

---

## Running

### Directly

```bash
cd /root/tmux-telegram
source .env  # or use dotenv
python bot.py
```

Or load the `.env` inline:

```bash
env $(cat .env | xargs) python bot.py
```

### As a systemd service

Create `/etc/systemd/system/tmux-telegram.service`:

```ini
[Unit]
Description=tmux-telegram Telegram routing bot
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

Enable and start:

```bash
systemctl daemon-reload
systemctl enable tmux-telegram
systemctl start tmux-telegram
systemctl status tmux-telegram
```

View logs:

```bash
journalctl -u tmux-telegram -f
```

---

## How it pairs with claude-telegram-channel

This bot is the **routing layer**. It:
1. Holds the single Telegram `getUpdates` long-poll
2. Writes each incoming message to `/tmp/tg-queue-{THREAD_ID}.jsonl` on the appropriate host
3. Provisions `.mcp.json` in each project directory pointing to the [claude-telegram-channel](https://github.com/shaike1/claude-telegram-channel) MCP server

The MCP server ([claude-telegram-channel](https://github.com/shaike1/claude-telegram-channel)) runs inside each Claude Code session and:
1. Tails its queue file for new messages
2. Fires `notifications/claude/channel` events into Claude
3. Exposes `send_message`, `typing`, `edit_message`, and `fetch_messages` tools

Together they form the full pipeline. Neither works without the other.

### Quick pairing example

After running `/new /root/myproject` in Telegram:

1. A new topic is created in your group
2. A tmux session `myproject` is started locally at `/root/myproject`
3. `.mcp.json` is written to `/root/myproject/` pointing the MCP server at this topic's `TELEGRAM_THREAD_ID`
4. Claude starts in the tmux session with the MCP server loaded
5. You can now message the topic and Claude responds

For `/new root@192.168.1.10 /root/myproject`, the same happens on the remote host via SSH.

---

## Security

- Only `OWNER_ID` can issue bot commands or have messages routed
- Keep `.env` private — never commit it (it's in `.gitignore`)
- Use a private Telegram group, not a public one
- Queue files in `/tmp/` are ephemeral and local to each machine

---

## License

MIT
