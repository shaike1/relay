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
│  relay-api (API + reverse proxy, port 7070)                   │
│  ├── /metrics, /sessions, /tasks, /orchestrator — dashboards │
│  ├── /api/* — metrics, orchestrator, scaling, session mgmt   │
│  ├── Auth: cookie + Basic + token URL                        │
│  └── proxy fallback → nomacode for web terminal              │
│                                                              │
│  nomacode (web terminal hub, internal port 3000)             │
│  ├── hub.sh — interactive session picker                     │
│  └── xterm.js frontend (proxied via relay-api)               │
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
| `send_task` | Delegate async task (with `depends_on` for milestone gating) |
| `complete_task` | Return task result (auto-dispatches waiting tasks) |
| `auto_dispatch` | Route task to best session by skill matching |
| `knowledge_read` | Read from shared knowledge library |
| `knowledge_write` | Write to shared knowledge library |

### 3. Session Containers

Each session runs in a Docker container with s6-overlay supervision:

- **claude-session-loop.sh** — Keeps Claude alive in a named tmux session, auto-resumes conversations
- **codex-session-loop.sh** — Same for OpenAI Codex sessions
- **copilot-session-loop.sh** — Same for GitHub Copilot sessions
- **message-watchdog.sh** — Polls queue files every 5s, nudges Claude/Codex via tmux when idle (60s grace). Detects both regular Telegram messages and peer/orchestrator messages by timestamp.

**Session types** (configured in `sessions.json`):
- `claude` — Claude Code agent (default)
- `codex` — OpenAI Codex agent
- `copilot` — GitHub Copilot agent

### 4. Relay API (`relay-api/server.js`)

Standalone Express server on port 7070. Serves all web dashboards, API endpoints, and proxies to nomacode for the web terminal.

**Auth:** Cookie-based with Basic Auth and token URL fallback. Login at `/login` or use `?token=<base64>` in any URL for direct access.

### 5. Orchestrator

Automatic task assignment and session coordination system built into relay-api.

**Components:**
- **Heartbeat System** — Scans all containers every 60s, reports status (ready/idle/busy/offline) and tmux activity
- **Smart Task Assignment** — Scores sessions by skill match (5pts), idle bonus (3pts), explicit target (20pts)
- **Task Lifecycle** — pending → assigned → complete/timeout (30min auto-timeout)
- **Merged View** — Combines orchestrator tasks with MCP agent-tasks (`/tmp/agent-tasks.json`)

**API Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/orchestrator/task` | POST | Submit task (title, description, skills, target, priority) |
| `/api/orchestrator/complete` | POST | Mark task complete with result |
| `/api/orchestrator/status` | GET | Full status: tasks, sessions, activity log |
| `/api/heartbeat` | POST | Session heartbeat report |

### 6. Hub System

**Web UI** — `relay.right-api.com` (nomacode + xterm.js)
- Login with credentials, get interactive terminal
- Hub menu lists all local + remote sessions
- Select a session to attach to its tmux

**SSH** — `ssh root@100.64.0.7`
- `.bashrc` auto-launches hub.sh on login
- Same interactive menu as web UI

### 7. Failover

**watchdog.sh** runs on the backup host (100.64.0.12):
- Checks primary health every 15s via SSH
- After 3 failures (45s), activates backup relay
- Sends Telegram alert on failover/recovery

## Web Dashboards

All dashboards are at `relay.right-api.com` behind auth. Use `?token=<base64>` for direct access.

| URL | Description |
|-----|-------------|
| `/metrics` | Live Metrics Dashboard — health score, session cards, activity bars, groups view, log viewer, restart buttons |
| `/sessions` | Sessions Manager — create/delete/start/stop sessions, auto-scaling controls, templates |
| `/sessions/{name}` | Session Detail — live tmux capture, queue viewer, tasks, logs per session |
| `/tasks` | Task Dashboard — Kanban (Pending/Waiting/Complete) + Timeline views with search & filters |
| `/orchestrator` | Orchestrator — live sessions heartbeat, task submission form, assignment queue, activity log |
| `/config` | Config Editor — edit sessions.json fields in a table UI |
| `/` | Web Terminal (nomacode) — xterm.js interactive hub |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/relay-metrics` | GET | Session metrics JSON (status, uptime, memory, activity) |
| `/api/session-logs` | GET | Container logs (`?session=name&lines=30`) |
| `/api/sessions-config` | GET/POST | Read/write sessions.json |
| `/api/session-restart` | POST | Restart a session container |
| `/api/session-create` | POST | Create new session (container + config) |
| `/api/session-stop` | POST | Stop a session container |
| `/api/session-delete` | POST | Delete session (container + config entry) |
| `/api/session-from-template` | POST | Create session from template |
| `/api/templates` | GET/POST | Read/write session templates |
| `/api/session-tmux` | GET | Capture tmux output (`?session=name&lines=50`) |
| `/api/session-queue` | GET | Read queue messages (`?thread_id=xxx&max=50`) |
| `/api/session-tasks` | GET | Read session tasks (`?session=name`) |
| `/api/tasks-all` | GET | Aggregated tasks from all sessions |
| `/api/scaling-status` | GET | Scaling overview (active/idle/down counts) |
| `/api/scale-up` | POST | Start all stopped sessions |
| `/api/scale-down` | POST | Stop idle sessions (4h+ inactive, protects infra) |
| `/api/orchestrator/task` | POST | Submit orchestrator task |
| `/api/orchestrator/complete` | POST | Complete orchestrator task |
| `/api/orchestrator/status` | GET | Orchestrator full status |
| `/api/heartbeat` | POST | Session heartbeat |
| `/api/login` | POST | Auth login |
| `/health` | GET | Health check |

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

### Orchestrator (Automatic)
The Orchestrator automatically assigns tasks to the best available session:
1. Submit task via API or dashboard with required skills/target
2. Orchestrator scores available sessions by skill match + availability
3. Task message delivered to session queue, watchdog nudges session
4. Session processes task, calls complete_task when done
5. 30-minute auto-timeout for unresponsive tasks

### Skill-Based Routing
Each session declares skills in `sessions.json`. `auto_dispatch` scores sessions by skill match:
- 8 points per explicit skill match (via `prefer_skills` parameter)
- 5 points per auto-detected skill from the prompt text

### Milestone Gating
Tasks can declare dependencies via `depends_on`:
```
send_task("codex", "deploy", depends_on: ["task-123", "task-456"])
```
Tasks with unmet dependencies get status `waiting`. When a dependency completes via `complete_task`, all waiting tasks whose dependencies are now met are automatically dispatched.

## Auto-Scaling

The Sessions Manager UI (`/sessions`) provides scaling controls:

- **Scale Up** — starts all stopped/exited session containers
- **Scale Down** — stops sessions idle for 4+ hours (protects `relay`, `main`, `copilot`)
- **Auto-restart watchdog** (`scripts/auto-restart-loop.sh`) — runs every 60s, restarts crashed containers

## Session Templates

6 built-in templates for quick session creation (`templates.json`):
- Claude Project, Codex Worker, Copilot Reviewer, Infra Ops, OpenClaw Dev, Remote Session

Create from template via `/sessions` UI or `POST /api/session-from-template`.

## Queue Persistence

Queue files survive container restarts via the `relay-queue` Docker named volume. An additional backup layer provides extra safety:

- **`scripts/queue-backup.sh`** — backup/restore queue files to `/root/relay/queues-backup/`
- **`scripts/queue-backup-loop.sh`** — daemon: restore on startup, backup every 5 minutes
- Registered as s6 service (`s6-overlay/s6-rc.d/queue-backup`)

## Configuration

### sessions.json
```json
{
  "thread_id": 213,
  "session": "main",
  "path": "/root",
  "host": null,
  "type": "claude",
  "skills": ["devops", "docker", "git", "general", "admin"],
  "group": "infra",
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
| `skills` | Skill tags for routing (e.g. `["python", "docker"]`) |
| `group` | Session group (e.g. `infra`, `openclaw`) |

### .env
```
TELEGRAM_BOT_TOKEN=...
OWNER_ID=...
GROUP_CHAT_ID=...
RELAY_API_PASS=...
```

## Docker Compose Structure

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Bot container (relay) + API server (relay-api) |
| `docker-compose.sessions.yml` | Local session containers (auto-generated) |
| `docker-compose.remote-{HOST}.yml` | Remote session containers (auto-generated) |
| `docker-compose.nomacode.yml` | Web terminal hub |

**Shared volume:** `relay-queue` — holds queue files, tmux sockets, state files, heartbeats, orchestrator state.

```bash
# Generate compose files from sessions.json
python3 scripts/generate-compose.py

# Start everything
docker compose up -d
docker compose -f docker-compose.sessions.yml up -d
docker compose -f docker-compose.nomacode.yml up -d
```

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

## File Manifest

| File | Purpose |
|------|---------|
| `bot.py` | Main relay bot — routing, polling, commands |
| `mcp-telegram/server.ts` | MCP server — Claude tools, peer messaging |
| `relay-api/server.js` | API server + orchestrator + nomacode proxy |
| `relay-api/Dockerfile` | API server container image |
| `scripts/claude-session-loop.sh` | Claude session lifecycle |
| `scripts/codex-session-loop.sh` | Codex session lifecycle |
| `scripts/copilot-session-loop.sh` | Copilot session lifecycle |
| `scripts/message-watchdog.sh` | Queue monitoring, tmux nudging |
| `scripts/hub.sh` | Interactive session picker (web + SSH) |
| `scripts/heartbeat-updater.sh` | Scans containers, writes heartbeat files |
| `scripts/heartbeat.sh` | Per-session heartbeat reporter |
| `scripts/aggregate-tasks.sh` | Collect tasks from all sessions |
| `scripts/session-tmux-capture.sh` | Capture tmux pane output |
| `scripts/session-queue.sh` | Read queue JSONL + state to JSON |
| `scripts/auto-restart-loop.sh` | Watchdog: auto-restart crashed containers |
| `scripts/metrics.sh` | Python metrics collector (~2s, batch docker stats) |
| `scripts/session-restart.sh` | Restart a session container |
| `scripts/session-logs.sh` | Fetch container logs |
| `scripts/queue-backup.sh` | Queue file backup/restore |
| `scripts/generate-compose.py` | Compose file generation from sessions.json |
| `watchdog.sh` | Primary-backup failover |
| `Dockerfile` | Bot container image |
| `session.Dockerfile` | Claude session container image |
| `codex-session.Dockerfile` | Codex session container image |
| `sessions.json` | Session registry (source of truth) |
| `templates.json` | Session templates (6 presets) |
| `metrics.html` | Live Metrics Dashboard UI |
| `sessions-ui.html` | Sessions Manager UI (scaling, CRUD, templates) |
| `session-detail.html` | Session Detail UI (tmux, queue, tasks, logs) |
| `tasks-dashboard.html` | Task Dashboard UI (Kanban + Timeline) |
| `orchestrator.html` | Orchestrator UI (heartbeat, task assignment, log) |
| `config.html` | Session Config Editor UI |

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
| Web Terminal | https://relay.right-api.com | Cookie / Basic Auth |
| Metrics | https://relay.right-api.com/metrics | Cookie / Basic / Token URL |
| Sessions | https://relay.right-api.com/sessions | Cookie / Basic / Token URL |
| Orchestrator | https://relay.right-api.com/orchestrator | Cookie / Basic / Token URL |
| Tasks | https://relay.right-api.com/tasks | Cookie / Basic / Token URL |
| Config | https://relay.right-api.com/config | Cookie / Basic / Token URL |
| API | https://relay.right-api.com/api/* | Basic Auth |
| SSH | `ssh root@100.64.0.7` | SSH key |
| Direct tmux | `docker exec -it relay-session-{name} tmux -S /tmp/tmux-{name}.sock attach` | Docker access |
