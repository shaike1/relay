# Relay

Control Claude Code from Telegram — no SSH, no terminal babysitting.

Send a message from your phone. Claude thinks inside the project directory. Replies with formatted code, logs, diffs — right back in the same Telegram topic.

## The problem this solves

Running Claude Code on a remote server is powerful but fragile:

- You SSH in, attach to tmux, start a session
- You step away — your SSH connection drops, or you close your laptop
- You come back, SSH in again, find tmux, figure out where things left off
- The server reboots — everything is gone, you rebuild from scratch

This is the normal remote dev workflow. It works, but it's constant overhead: maintaining connections, babysitting sessions, manually restarting things after downtime.

**Relay removes that entirely.** Your projects run as persistent tmux sessions managed by a systemd service. Claude auto-resumes its last conversation on restart. You interact through Telegram — which is always open on your phone anyway. A dropped SSH connection changes nothing. A server reboot? The service comes back up, Claude resumes, your Telegram topic is right where you left it.

To add a new project, send one command in Telegram:

```
# Local project on the relay server
/new /path/to/project

# Project on a remote server over SSH
/new root@your-backup-host /root/myproject

# With a custom topic name
/new root@your-backup-host /root/myproject my-app
```

In one command, Relay does all of this automatically:

1. **Creates the Telegram topic** in your supergroup (gets a `thread_id`)
2. **Creates the project folder** on the target host if it doesn't exist
3. **Writes `.mcp.json`** into the project folder, wired to the new topic's `thread_id`
4. **Creates a tmux session** on the host (local or remote via SSH) in the project directory
5. **Launches Claude** in a self-restarting loop — `--continue` to resume any prior conversation, falling back to a fresh start if none exists
6. **Registers the session** in `sessions.json` so it survives relay restarts
7. **Sends a confirmation message** into the new topic so it's immediately live

For remote projects, Relay SSHes in to provision everything — no manual setup on the remote host needed.

```
Phone
  ↓
Telegram topic (one per project)
  ↓
Relay bot (single getUpdates long-poll)
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

Telegram's [forum topics](https://telegram.org/blog/topics-in-groups-collectible-usernames) give each thread a unique `message_thread_id`. Relay uses that ID as the key for everything:

- **One topic = one project.** Each Telegram topic maps to exactly one tmux session running Claude Code in a specific directory. Messages stay isolated — no cross-talk between projects.
- **One long-poll, many consumers.** Telegram returns `409 Conflict` if two processes call `getUpdates` with the same bot token. The Relay bot holds the single long-poll and writes each incoming message to a queue file named after the topic's thread ID: `/tmp/tg-queue-{THREAD_ID}.jsonl`. Each MCP server instance reads only its own file — no conflicts, no duplicated API calls.
- **Queue files as the handoff.** The queue file decouples the Relay bot from Claude's lifecycle. If Claude restarts mid-session, Relay keeps running and the queue keeps filling. When Claude comes back up, the MCP server resumes tailing from where it left off.
- **`sessions.json` as the source of truth.** The mapping of `thread_id → session name → project path → host` lives in `sessions.json`. Add a line and Relay knows which tmux session to write to and which queue file to update.

---

## What's in this repo

| Path | What it is |
|------|-----------|
| `bot.py` | Relay bot — runs once, globally. Holds the Telegram long-poll, fans messages to queue files, provisions tmux sessions. |
| `mcp-telegram/` | MCP server — one instance per project. Tails its queue file and delivers messages to Claude as `notifications/claude/channel` events. |
| `CLAUDE_TEMPLATE.md` | Paste into your project's `CLAUDE.md` to tell Claude how to behave on Telegram. |
| `watchdog.sh` | Deploy to backup server. Monitors primary relay every 15s, activates backup relay after 45s down, sends Telegram alert on failover/recovery. |
| `self-monitor.sh` | Run via cron on primary. Detects relay outage, attempts auto-restart, sends direct Telegram alert if restart fails. |
| `sync-sessions.sh` | Run via cron on primary. Pushes host-flipped `sessions.json` to backup server every 5 minutes. |

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

### 1. Clone and run the install script

```bash
git clone https://github.com/shaike1/relay
cd relay
bash install.sh
```

The script installs Python deps, installs/symlinks Bun, writes your `.env`, sets up MCP credentials, and installs the systemd service — prompting only for what's missing.

To install manually instead, expand the steps below.

### 2. Create your Telegram bot

- Open [@BotFather](https://t.me/BotFather), send `/newbot`, follow the steps, copy the token
- Disable privacy mode: BotFather → `/mybots` → your bot → **Bot Settings → Group Privacy → Turn off**

### 3. Set up your Supergroup

- Create a Telegram group → Settings → **Topics: Enable**
- Add your bot as **Admin** with "Manage Topics" permission

### 4. Configure Relay

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

### 5. Start Relay

```bash
python bot.py
```

Or as a systemd service (recommended):

```ini
# /etc/systemd/system/relay.service
[Unit]
Description=Relay — Telegram to Claude Code bridge
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/relay
EnvironmentFile=/root/relay/.env
ExecStart=/usr/bin/python3 /root/relay/bot.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable relay
systemctl start relay
journalctl -u relay -f
```

With systemd, Relay survives reboots and restarts automatically if it crashes. Claude sessions run in tmux and auto-resume their last conversation (`claude --resume`) each time they start — so a reboot or disconnect doesn't lose your context.

### 6. Add the MCP server to a project

In your project folder, create `.mcp.json`:
```json
{
  "mcpServers": {
    "telegram": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/relay/mcp-telegram", "--silent", "start"],
      "env": {
        "TELEGRAM_THREAD_ID": "YOUR_THREAD_ID"
      }
    }
  }
}
```

Replace `/path/to/relay` with where you cloned this repo. `TELEGRAM_THREAD_ID` is the `message_thread_id` for this project's Telegram topic (run `getUpdates` and look in the message object).

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

> **Tip: use `/new` instead of steps 6–8.** The bot command `/new /path/to/project` handles creating the topic, tmux session, `.mcp.json`, and launching Claude in one step. Steps 6–8 are for wiring up an existing project manually.

---

## Three ways to interact with any session

Because every session runs with `--remote-control`, each Claude instance registers itself with Anthropic's infrastructure and generates a `claude.ai/code/session_...` URL. This means you have three parallel interfaces to every project — all talking to the same live session:

| Interface | How to access | Notes |
|-----------|--------------|-------|
| **Telegram** | Send a message in the topic | Always available while bot is running |
| **Web / mobile app** | Open the `claude.ai/code/session_...` URL | Works in any browser or the Claude mobile app |
| **Terminal** | `ssh server` → `tmux attach -t session-name` | Direct shell access |

The session URL is printed in the tmux pane each time Claude starts:
```
/remote-control is active. Code in CLI or at
https://claude.ai/code/session_<your-session-id>
```

**Tip:** The URL changes on each restart. Use `/snap` to capture the current pane and find the latest URL, or add a `/url` bot command to extract and send it directly to the Telegram topic.

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
| `/restart` | Quit Claude gracefully then re-launch (resumes latest session) |
| `/restart_all [host]` | Restart all sessions across all hosts — useful after settings changes |
| `/kill` | Send Ctrl+C to the session |
| `/snap` | Snapshot the last 50 lines of the tmux pane |
| `/mcp_add <name> <binary> [args...] [KEY=VAL...]` | Install an MCP server and restart Claude |
| `/link [session]` | Get a direct `t.me` link to any session's topic |
| `/upgrade` | Upgrade Claude Code on all hosts, then restart all sessions |

**`/mcp_add` example:**
```
/mcp_add stitch stitch-mcp proxy STITCH_API_KEY=abc123
```
Resolves the binary's full path on the target host (handles `npm`/`nvm` installs not in Claude's PATH), adds it via `claude mcp add-json`, and restarts Claude — all from Telegram.

### Info

| Command | Description |
|---------|-------------|
| `/sessions` | List all configured sessions |
| `/status` | Show topic↔session mappings |

---

## MCP tools available to Claude

| Tool | Description |
|------|-------------|
| `send_message` | Send text to the topic (HTML: `<b>`, `<i>`, `<code>`, `<pre>`). Optional `buttons` param for inline keyboards. |
| `edit_message` | Edit a previously sent message |
| `typing` | Show typing indicator (~5s) |
| `fetch_messages` | Get recent message history from this session |

### Inline keyboard buttons

Claude can send messages with clickable buttons. When a button is pressed, the label arrives as a regular message:

```python
send_message(text="Continue?", buttons=[["✅ Yes", "❌ No"]])
```

### Photo support

Photos sent to a topic are downloaded to `/tmp/tg-photo-{id}.jpg` (SCP'd to remote hosts automatically). Claude receives `[Photo: /tmp/...] caption` and can read the image with the `Read` tool.

---

## Webhook mode (faster updates)

By default the bot uses `getUpdates` polling (2s interval). For instant delivery, configure webhook mode by adding these to `.env`:

```
WEBHOOK_URL=https://<your-public-ip>:88
WEBHOOK_PORT=18793
WEBHOOK_CERT=/etc/ssl/certs/relay-webhook.crt
```

Then add a Caddy (or nginx) block to terminate TLS and forward to port 18793, and generate a self-signed cert for your IP:

```bash
openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/relay-webhook.key \
  -out /etc/ssl/certs/relay-webhook.crt -days 3650 -nodes \
  -subj "/CN=<your-ip>" -addext "subjectAltName=IP:<your-ip>"
```

Telegram accepts self-signed certs on ports 443, 80, 88, and 8443. The bot uploads the cert automatically on startup.

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

Relay SSHes to write queue files and provision sessions on remote hosts. SSH key auth required (no password prompts).

---

## Redundancy and monitoring

Relay is designed to run on one server (only one process can hold the Telegram long-poll). For high availability, use a primary/backup pattern with automatic failover.

### Backup relay (watchdog)

Deploy `watchdog.sh` on your backup server as a systemd service. It monitors the primary every 15 seconds and activates the backup relay after 45 seconds of downtime:

```bash
# On backup server
cp watchdog.sh /root/relay/watchdog.sh
chmod +x /root/relay/watchdog.sh
```

Edit `watchdog.sh` and set `PRIMARY` to your primary server's SSH address.

```ini
# /etc/systemd/system/relay-watchdog.service
[Unit]
Description=Relay Watchdog — failover if primary is down
After=network.target

[Service]
Type=simple
User=root
ExecStart=/bin/bash /root/relay/watchdog.sh
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now relay-watchdog
```

The backup relay needs its own `sessions.json` with hosts flipped (what is `null` on primary becomes `"root@primary-ip"` on backup, and vice versa). Use `sync-sessions.sh` to keep it in sync automatically.

### Sessions sync

Run `sync-sessions.sh` on the primary via cron to keep the backup's `sessions.json` up to date:

```bash
# Edit sync-sessions.sh and set the backup server address
(crontab -l; echo "*/5 * * * * /root/relay/sync-sessions.sh >> /root/relay/sync.log 2>&1") | crontab -
```

### Self-monitoring on primary

Run `self-monitor.sh` on the primary via cron. If the relay goes down and `systemctl restart` fails, it sends a direct Telegram alert (bypassing the relay itself):

```bash
(crontab -l; echo "*/2 * * * * /root/relay/self-monitor.sh >> /root/relay/self-monitor.log 2>&1") | crontab -
```

### Failover behavior

| Session location | Primary down | Primary recovers |
|-----------------|-------------|-----------------|
| Backup server | ✅ continues working | ✅ continues working |
| Primary server | ❌ unavailable | ✅ resumes automatically |

Telegram alerts are sent directly via the Bot API (not through Relay) so they arrive even when Relay itself is down.

---

## Troubleshooting

### MCP server fails to start (`telegram · ✘ failed`)

**Cause:** `bun` is not in the system PATH Claude uses when spawning MCP servers.

**Fix:**
```bash
sudo ln -sf ~/.bun/bin/bun /usr/local/bin/bun
which bun  # should show /usr/local/bin/bun
```

### Adding extra MCP servers to a project (e.g. Stitch, custom tools)

When adding MCP servers installed via `npm`/`nvm`, Claude Code spawns them with a minimal PATH — `~/.nvm/...` is not included, so the binary won't be found by name alone.

**Always use the full binary path:**
```bash
# Find the full path first
which stitch-mcp   # e.g. /root/.nvm/versions/node/v22.22.0/bin/stitch-mcp

# Add with full path + any required env vars
claude mcp add-json stitch '{
  "command": "/root/.nvm/versions/node/v22.22.0/bin/stitch-mcp",
  "args": ["proxy"],
  "env": {"STITCH_API_KEY": "your-key"}
}' -s local
```

Then restart Claude to pick up the new MCP. Use `session-run.sh` for a one-liner:
```bash
./session-run.sh <session-name> claude mcp add-json stitch '{...}' -s local
```

### 409 Conflict errors

**Cause:** Two processes are calling `getUpdates` with the same token.

**Fix:** Only the Relay bot (`bot.py`) should poll. The MCP server reads queue files only — it never calls `getUpdates`.

### Messages not arriving

1. Is Relay running? `systemctl status relay` or `tmux ls`
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
