# Claude Telegram Relay

A Docker-based orchestration system that runs AI agent sessions (Claude, Codex, Copilot) over Telegram. Each Telegram forum topic maps to a dedicated session container, enabling multi-project, multi-agent collaboration through a unified chat interface.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    PRIMARY (100.64.0.7)                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  relay (bot container)                                       │
│  ├── bot.py — single Telegram long-poll, routes messages     │
│  └── s6-overlay supervision                                  │
│                                                              │
│  relay-session-{name} (one per session)                      │
│  ├── claude-session-loop.sh / codex-session-loop.sh          │
│  ├── mcp-telegram/server.ts (MCP tools for Claude)           │
│  ├── message-watchdog.sh (nudges idle sessions)              │
│  └── per-session tmux socket: /tmp/tmux-{name}.sock          │
│                                                              │
│  nomacode (web terminal hub)                                 │
│  ├── hub.sh — interactive session picker                     │
│  └── xterm.js frontend (port 7070, Caddy TLS)               │
│                                                              │
│  Shared: relay-queue volume (/tmp/tg-queue-*.jsonl)          │
└──────────────────────────────┬──────────────────────────────┘
                               │ SSH
┌──────────────────────────────┴──────────────────────────────┐
│                    BACKUP (100.64.0.12)                       │
│  ├── relay-session-{name} (remote sessions)                  │
│  └── watchdog.sh (activates if primary goes down)            │
└─────────────────────────────────────────────────────────────┘
```

## Core Concept

**One Telegram topic = one session container = one project directory.**

Messages are persisted in queue files (`/tmp/tg-queue-{THREAD_ID}.jsonl`), decoupling delivery from session lifecycle. Sessions can restart, crash, or go idle without losing messages.

## Components

### 1. Relay Bot (`bot.py`)

The central orchestrator. Holds the exclusive Telegram `getUpdates` long-poll and routes all messages.

**Key responsibilities:**
- Route incoming messages to session queue files
- Provision new sessions via `/new` command
- Poll session output for status updates (every 2s)
- Detect stuck sessions and auto-restart (10min no-reply threshold)
- Handle `@mention` cross-topic linking
- 21 slash commands for session management

**Message flow:**
```
User (Telegram) → bot.py → /tmp/tg-queue-{THREAD_ID}.jsonl → MCP server → Claude
```

### 2. MCP Telegram Server (`mcp-telegram/server.ts`)

One instance per session. Gives Claude tools to interact with Telegram via the Model Context Protocol.

**Tools exposed to Claude:**

| Tool | Purpose |
|------|---------|
| `send_message` | Post to Telegram (HTML, buttons) |
| `fetch_messages` | Read recent messages from queue |
| `send_file` | Upload files to Telegram |
| `edit_message` | Modify previous messages |
| `react` | Add emoji reactions |
| `typing` | Show typing indicator |
| `list_peers` | Discover other sessions |
| `message_peer` | Send message to another session |
| `send_task` | Delegate async task to another session |
| `complete_task` | Return task result to requester |

### 3. Session Containers

Each session runs in a Docker container with s6-overlay supervision:

- **claude-session-loop.sh** — Keeps Claude alive in a named tmux session, auto-resumes conversations
- **codex-session-loop.sh** — Same for OpenAI Codex sessions
- **copilot-session-loop.sh** — Same for GitHub Copilot sessions
- **message-watchdog.sh** — Polls queue files every 5s, nudges Claude via tmux when idle (60s grace)

**Session types** (configured in `sessions.json`):
- `claude` — Claude Code agent (default)
- `codex` — OpenAI Codex agent
- `copilot` — GitHub Copilot agent

### 4. Hub System

**Web UI** — `relay.right-api.com` (nomacode + xterm.js)
- Login with credentials, get interactive terminal
- Hub menu lists all local + remote sessions
- Select a session to attach to its tmux

**SSH** — `ssh root@100.64.0.7`
- `.bashrc` auto-launches hub.sh on login
- Same interactive menu as web UI

### 5. Failover

**watchdog.sh** runs on the backup host (100.64.0.12):
- Checks primary health every 15s via SSH
- After 3 failures (45s), activates backup relay
- Sends Telegram alert on failover/recovery

## Cross-Session Collaboration

Sessions can communicate with each other through multiple channels. This is what makes the system more than just "Claude on Telegram" — it's a multi-agent orchestration platform.

### @Mention Routing
When a user types `@session-name` in any topic:
1. Bot detects the mention and posts a clickable link to the target topic
2. Bot forwards the message to the target session's queue with `force: true`
3. Target session's watchdog nudges it immediately

### Peer Messaging (MCP Tools)
Claude can directly communicate with other sessions:
```
list_peers()                          → discover available sessions
message_peer("codex", "review this")  → send message to codex session
send_task("codex", "run tests", 300)  → delegate task with 5min timeout
complete_task(task_id, "all passed")  → return result to requester
```

### Cross-Tool Orchestration
Different AI tools can collaborate on the same work:
- **Claude** analyzes code and plans changes
- **Codex** executes code changes
- **Copilot** provides code suggestions and reviews
- All communicate via `message_peer` / `send_task` through Telegram relay
- Each session has visibility into what other sessions are working on via `list_peers`

## Configuration

### sessions.json
```json
{
  "thread_id": 213,
  "session": "main",
  "path": "/root",
  "host": null,
  "type": "claude",
  "allowed_users": [6831389652]
}
```

| Field | Description |
|-------|-------------|
| `thread_id` | Telegram forum topic ID |
| `session` | Unique session name |
| `path` | Working directory |
| `host` | `null` = local, `"root@host"` = remote |
| `type` | `claude`, `codex`, or `copilot` |
| `allowed_users` | Optional: restrict to specific Telegram user IDs |

### .env
```
TELEGRAM_BOT_TOKEN=...
OWNER_ID=...
GROUP_CHAT_ID=...
```

### hosts.json
```json
["root@100.64.0.12"]
```

### .mcp.json (auto-generated per session)
```json
{
  "mcpServers": {
    "telegram": {
      "command": "/root/.bun/bin/bun",
      "args": ["run", "--cwd", "/root/relay/mcp-telegram", "server.ts"],
      "env": {
        "TELEGRAM_THREAD_ID": "213",
        "SESSION_NAME": "main"
      }
    }
  }
}
```

## Docker Compose Structure

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Bot container (relay) |
| `docker-compose.sessions.yml` | Local session containers (auto-generated) |
| `docker-compose.remote-{HOST}.yml` | Remote session containers (auto-generated) |
| `docker-compose.nomacode.yml` | Web terminal hub |

**Shared volume:** `relay-queue` — holds queue files, tmux sockets, state files.

Generate compose files from sessions.json:
```bash
python3 scripts/generate-compose.py
```

## Telegram Commands

| Command | Purpose |
|---------|---------|
| `/new {path} [name]` | Create new session + topic |
| `/restart {session}` | Restart Claude in session |
| `/status` | Show all sessions with activity |
| `/sessions` | List session configs |
| `/kill {session}` | Remove session |
| `/snap {session}` | Screenshot tmux output |
| `/model {model}` | Set Claude model |
| `/reload` | Reload sessions.json |
| `/addhost {root@host}` | Register remote host |
| `/discover` | Find projects on all hosts |
| `/link {path}` | Link existing project |
| `/upgrade` | Update Claude Code |
| `/mcp_add {name} {cmd}` | Add MCP server to session |
| `/restart_all` | Restart all sessions |
| `/delegate {task}` | Route task to best agent |

## Data Flow Example

```
1. User types in "main" topic: "fix the bug @codex"
2. bot.py receives via getUpdates
3. Writes to /tmp/tg-queue-213.jsonl
4. Detects @codex → writes to /tmp/tg-queue-8542.jsonl, posts link
5. message-watchdog nudges Claude in main session
6. Claude calls fetch_messages() → sees the request
7. Claude calls send_message("checking...") → posts to Telegram
8. Claude calls send_task("codex", "run the test suite")
9. Codex session receives task, runs tests, calls complete_task()
10. Claude gets result via fetch_messages(), reports back
```

## Queue File Format

Messages stored as newline-delimited JSON:
```json
{"text": "[Alice]: fix the bug", "user": "Alice", "message_id": 12345, "ts": 1712000000.5}
{"text": "button clicked", "force": true, "message_id": -1711999999500, "ts": 1712000005.0}
```

State tracking (`/tmp/tg-queue-{THREAD_ID}.state`):
```json
{"lastId": 12345, "ackedForce": [-1711999999500]}
```

## File Manifest

| File | Purpose |
|------|---------|
| `bot.py` | Main relay bot — routing, polling, commands |
| `mcp-telegram/server.ts` | MCP server — Claude tools, peer messaging |
| `scripts/claude-session-loop.sh` | Claude session lifecycle |
| `scripts/codex-session-loop.sh` | Codex session lifecycle |
| `scripts/copilot-session-loop.sh` | Copilot session lifecycle |
| `scripts/message-watchdog.sh` | Queue monitoring, tmux nudging |
| `scripts/hub.sh` | Interactive session picker (web + SSH) |
| `scripts/mcp-server-wrapper.sh` | MCP server supervision |
| `scripts/generate-compose.py` | Compose file generation from sessions.json |
| `watchdog.sh` | Primary-backup failover |
| `Dockerfile` | Bot container image |
| `session.Dockerfile` | Claude session container image |
| `codex-session.Dockerfile` | Codex session container image |
| `sessions.json` | Session registry (source of truth) |
| `hosts.json` | Remote host registry |
| `capabilities.json` | Agent capability declarations |
| `peers-topic.json` | Cross-session communication audit log |

## Quick Start

```bash
# 1. Configure
cp .env.example .env  # Set TELEGRAM_BOT_TOKEN, OWNER_ID, GROUP_CHAT_ID

# 2. Build
docker build -t topix-relay:latest -f Dockerfile .
docker build -t relay-session:latest -f session.Dockerfile .

# 3. Generate compose files
python3 scripts/generate-compose.py

# 4. Launch
docker compose up -d
docker compose -f docker-compose.sessions.yml up -d

# 5. Create first session (in Telegram relay topic)
/new /root/myproject
```

## Access Points

| Method | URL / Command | Auth |
|--------|---------------|------|
| Telegram | Forum topics in relay group | Telegram user ID |
| Web Terminal | https://relay.right-api.com | Username + password |
| SSH | `ssh root@100.64.0.7` | SSH key |
| Direct tmux | `docker exec -it relay-session-{name} tmux -S /tmp/tmux-{name}.sock attach` | Docker access |
