# Claude Telegram Relay

> Run Claude Code, Codex, and Copilot as **persistent, containerized agents** — controlled from Telegram, Discord, WhatsApp, or Slack. One topic per project. No polling. No babysitting.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/shaike1/relay)](https://github.com/shaike1/relay/releases)

**Step away from your computer. Your AI agents keep working — and you stay in control from your phone.**

## What is this?

A Docker-based orchestration system that maps **Telegram forum topics → AI agent sessions**. Send a message in a topic and the corresponding Claude/Codex/Copilot session responds — with full tool use, inline buttons, voice transcription, file uploads, and peer-to-peer messaging between sessions.

```
You (Telegram/Discord/WhatsApp/Slack) → Relay → Queue → MCP → Claude Code
                                                                    ↓
You ←──────────────────────────────────── send_message ─────────────
```

## Features

### Core
- **Webhook-driven** — No polling. Instant delivery via Telegram Bot API webhooks
- **Multi-session** — 16+ concurrent sessions, each isolated in its own Docker container
- **Multi-agent** — Mix Claude Code, OpenAI Codex, and GitHub Copilot in the same group
- **Inline buttons** — Claude sends buttons; clicking shows `✓ label` visual feedback
- **Button callbacks** — Clicking always reaches Claude (fixed force-delivery)
- **Rate limiting** — 30 messages/minute per user, enforced in-memory
- **Health endpoint** — `GET /health` for uptime monitors (UptimeRobot, etc.)

### Messaging & Media
- **Voice messages** — Auto-transcribed via OpenAI Whisper API; fallback saves to `/tmp`
- **Photos/images** — Downloaded to `/tmp`, path sent to Claude for analysis
- **Reaction commands** — 👍=Continue 🔁=Retry ❌=Cancel ✅=Confirm 🚀=Deploy 🛑=Stop 💡=Implement 🤔=Explain
- **Message flood control** — 1.5s merge window deduplicates rapid messages before queuing
- **Mention routing** — `@session_name text` copies message to that session's queue
- **Multi-platform bridges** — Discord, WhatsApp, and Slack (bidirectional)

### Agent Control
- **PostToolUse hook** — Real-time Bash/Edit/Write notifications sent to Telegram as each tool fires (replaces tmux polling)
- **PreToolUse hook** — Dangerous command detection with inline confirmation buttons before execution
- **Graceful shutdown** — Alert + context save triggered via s6 finish script before container stops
- **Live streaming** — Pane content streamed every 2s while Claude works; deleted on completion
- **Session crash alerts** — Auto-alert after N minutes of silence (fires once per silence period)
- **Context compaction alerts** — Notified before context is compacted; memory extracted automatically
- **Context handoff** — On restart, Claude automatically receives the last session summary
- **Startup token savings** — Only wakes Claude when there are pending messages
- **Response time** — ⏱ Xs appended to every Claude `send_message` response
- **Orchestrator sessions** — `delegate_task` routes subtasks to specialized sessions and awaits results

### Commands (no Claude tokens)
- `/status` — Container health for all sessions
- `/history [page]` — Paginated message history (12/page, prev/next buttons)
- `/stats` — Token usage + USD cost breakdown (today + cumulative)
- `/template [name]` — List or apply session templates
- `/cancel` — Send SIGINT to stop Claude mid-task
- `/restart` — Restart a session container
- `/pause` / `/resume` — Pause or resume a session's watchdog
- `/ask <session> <question>` — Send a question directly to another session
- `/pin` — Save a replied-to message into the shared knowledge base
- `/report` — Daily summary: message count, tool calls, tokens, and cost
- `/pr [repo]` / `/issues [repo]` — GitHub CLI integration (list PRs and issues)
- `/deploy [service]` — Docker restart a service from Telegram
- `/ls [path]` / `/cat [file]` — File browser commands
- `/screenshot [session]` — Capture and send a tmux pane screenshot
- `/rollback [session]` — Roll back a session to its previous Docker image
- `/export-config` — Export current config to Telegram as a file

### Scheduling & Automation
- **Scheduled tasks** — Cron-like scheduler (`schedules.json`, 5-field cron expressions)
- **Auto-summary** — Daily session summaries via `auto-summary.sh` + scheduler
- **Token compaction** — Scheduled daily + auto-threshold at 50K output tokens
- **Plugin/Skills system** — Per-session skill files injected into `CLAUDE.md` at startup
- **Session templates** — Pre-configured `devops`, `fullstack` (extensible)

### Infrastructure
- **Peer messaging** — Sessions message each other (`message_peer`)
- **Task delegation** — Async task queue with skill-based routing (`send_task` / `complete_task`)
- **Multi-tenant** — Per-user session isolation (`multi_tenant: true` in sessions.json)
- **Token optimizer** — Waste detection + smart compaction triggers
- **Memory persistence** — `memory_write`/`memory_read` key-value store, injected at session startup
- **Web dashboard** — Session status, metrics, web terminal, live logs, tool call timeline, token graph (Chart.js)
- **Remote sessions** — Sessions on remote hosts via SSH
- **CI/CD** — GitHub Actions auto-builds and pushes session image on every push
- **MCP auto-restart** — Watchdog detects missing MCP server and restarts session
- **Audit log** — JSONL per-session tool call log + `GET /api/audit/:session` endpoint
- **Hot reload** — Config changes applied without full restart
- **44 integration tests** — `npm test` covers API, MCP, commands, and hooks
- **backup.sh / restore.sh** — Daily auto-backup with 7-day retention
- **upgrade.sh** — One-command upgrade: backup → git pull → rebuild → restart
- **migrate-session.sh** — SSH-based session migration to a new host

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                           Your Server                             │
├──────────────────────────────────────────────────────────────────┤
│  relay-api (port 443 via Caddy)                                   │
│  ├── Telegram/Discord/WhatsApp/Slack webhook receivers            │
│  ├── /status /history /stats /template /cancel /restart commands  │
│  ├── /pin /report /ask /pr /issues /deploy /ls /cat commands      │
│  ├── /screenshot /rollback /export-config /pause /resume commands │
│  ├── Cron scheduler (schedules.json)                              │
│  ├── Rate limiter (30 msg/min per user)                           │
│  ├── Message merge buffer (flood control, 1.5s window)            │
│  ├── GET /health endpoint                                         │
│  ├── Web dashboard + live logs (SSE) + tool timeline + token graph│
│  └── Reverse proxy → nomacode (web terminal)                      │
│                                                                   │
│  discord-bridge (profile: discord)   :9102                        │
│  whatsapp-bridge (profile: whatsapp) :9103                        │
│  slack-bridge    (profile: slack)    :9104                        │
│                                                                   │
│  relay-session-{name}  (one per Telegram topic)                   │
│  ├── Claude Code / Codex / Copilot loop                           │
│  ├── mcp-telegram server (MCP tools for Claude)                   │
│  ├── PostToolUse hook → real-time Telegram notifications          │
│  ├── PreToolUse hook  → dangerous-command confirmation            │
│  ├── Graceful shutdown hook (s6 finish)                           │
│  ├── message-watchdog (nudges + tool monitor + streaming)         │
│  └── token-logger (Stop hook → /tmp/token-stats-*.jsonl)          │
│                                                                   │
│  Shared: relay-queue volume (/tmp/tg-queue-*.jsonl)               │
└──────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Docker (no docker-compose needed — uses `docker compose`)
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- A Telegram supergroup with **Topics enabled**
- Claude Code CLI installed and authenticated
- A domain with HTTPS (Caddy handles TLS automatically)

### One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/shaike1/relay/main/install.sh | bash
```

### Manual setup

```bash
git clone https://github.com/shaike1/relay.git
cd relay

# Configure environment
cp .env.example .env
nano .env  # Fill in your tokens

# Build session image
docker build -t relay-session:latest -f session.Dockerfile .

# Start core services
docker compose up -d

# Register Telegram webhook (or use the dashboard)
curl -X POST https://your-domain.com/api/webhook/set \
  -H "Authorization: Basic $(echo -n relay:YOUR_PASS | base64)" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-domain.com"}'
```

### Add Sessions

Edit `sessions.json`:

```json
[
  {
    "thread_id": 183,
    "session": "myproject",
    "path": "/root/myproject",
    "host": null,
    "group": "dev",
    "type": "claude",
    "skills": ["docker", "git"],
    "env": { "STREAM_MONITOR": "0" },
    "discord_channel_id": "123456789",
    "whatsapp_jid": "972501234567"
  }
]
```

Then regenerate and start:

```bash
python3 scripts/generate-compose.py
docker compose -f docker-compose.sessions.yml up -d
```

### Enable Discord, WhatsApp, or Slack

```bash
# Discord bridge
echo "DISCORD_BOT_TOKEN=..." >> .env
docker compose --profile discord up -d discord-bridge

# WhatsApp bridge (QR code sent to Telegram)
docker compose --profile whatsapp up -d whatsapp-bridge

# Slack bridge
echo "SLACK_BOT_TOKEN=..." >> .env
docker compose --profile slack up -d slack-bridge
```

### Set Up Auto-Backup

```bash
# Installs a daily cron job — 7-day retention
bash scripts/backup.sh --install-cron

# Restore from a backup
bash scripts/restore.sh backups/relay-2026-04-05.tar.gz
```

### Upgrade

```bash
# Backup → git pull → rebuild → restart in one command
bash scripts/upgrade.sh
```

## MCP Tools Available to Claude

| Tool | Description |
|------|-------------|
| `send_message` | Send HTML message with optional inline buttons |
| `fetch_messages` | Read recent messages from the topic queue |
| `typing` | Show typing indicator |
| `send_file` | Upload file to Telegram |
| `send_code` | Send a code block with native Telegram tap-to-copy button |
| `send_diff` | Send a formatted git diff with stats |
| `edit_message` | Edit a previously sent message |
| `react` | Add emoji reaction to a message |
| `list_peers` | List all active sessions |
| `message_peer` | Send a message to another session |
| `send_task` | Delegate async task to a session |
| `complete_task` | Return task result |
| `delegate_task` | Delegate a task to another session (orchestrator mode) |
| `auto_dispatch` | Route task to best session by skill match |
| `knowledge_read` | Read from shared knowledge base |
| `knowledge_write` | Write to shared knowledge base |
| `memory_read` | Read a persistent key-value entry (survives restarts) |
| `memory_write` | Write a persistent key-value entry (survives restarts) |
| `get_session_context` | Get context summary + last 5 messages for any session |
| `broadcast` | Send to all sessions |

## sessions.json Fields

| Field | Type | Description |
|-------|------|-------------|
| `thread_id` | number | Telegram topic message thread ID |
| `session` | string | Session name (container name suffix) |
| `path` | string | Working directory |
| `host` | string\|null | null = local, "user@host" = remote SSH |
| `type` | string | "claude", "codex", or "copilot" |
| `skills` | string[] | Skills for auto_dispatch routing |
| `env` | object | Per-session env overrides (no restart needed) |
| `discord_channel_id` | string | Discord channel for bidirectional bridge |
| `whatsapp_jid` | string | WhatsApp phone/group JID |
| `multi_tenant` | bool | Per-user session isolation |
| `allowed_users` | number[] | Restrict to specific Telegram user IDs |

## Comparison with ccbot

| Feature | **relay** | ccbot |
|---------|-----------|-------|
| Delivery mode | **Webhook** (instant) | Polling |
| Multi-agent | Claude + Codex + Copilot | Claude only |
| Inline buttons | ✓ with `✓` feedback | ✗ |
| Button callbacks reach Claude | ✓ (fixed) | — |
| Voice transcription (Whisper) | ✓ | ✗ |
| Photo/image support | ✓ | ✗ |
| Reaction commands | ✓ (👍🔁❌✅🚀🛑) | ✗ |
| Discord bridge | ✓ bidirectional | ✗ |
| WhatsApp bridge | ✓ bidirectional + QR | ✗ |
| Slack bridge | ✓ bidirectional | ✗ |
| Real-time tool monitoring | ✓ PostToolUse hook | ✗ |
| Pre-execution confirmation | ✓ PreToolUse hook | ✗ |
| Live pane streaming | ✓ | ✗ |
| Screenshot / pane capture | ✓ `/screenshot` | ✗ |
| Session crash alerts | ✓ | ✗ |
| PreCompact notifications | ✓ | ✗ |
| Graceful shutdown | ✓ s6 finish hook | ✗ |
| Context handoff on restart | ✓ | ✗ |
| Message flood control | ✓ 1.5s merge window | ✗ |
| Rate limiting | ✓ 30 msg/min | ✗ |
| /status (no tokens) | ✓ | ✗ |
| /history pagination | ✓ | ✗ |
| /stats token + cost | ✓ | ✗ |
| /template session templates | ✓ | ✗ |
| /cancel / /restart | ✓ | ✗ |
| /pause / /resume | ✓ | ✗ |
| /ask cross-session | ✓ | ✗ |
| /pin to knowledge base | ✓ | ✗ |
| /report daily summary | ✓ | ✗ |
| /pr / /issues GitHub CLI | ✓ | ✗ |
| /deploy Docker restart | ✓ | ✗ |
| /ls / /cat file browser | ✓ | ✗ |
| /rollback image | ✓ | ✗ |
| /export-config | ✓ | ✗ |
| Scheduled tasks (cron) | ✓ | ✗ |
| Plugin/skills system | ✓ | ✗ |
| Multi-tenant per-user | ✓ | ✗ |
| Peer messaging | ✓ | ✗ |
| Task delegation + routing | ✓ | ✗ |
| Orchestrator sessions | ✓ delegate_task | ✗ |
| Memory persistence | ✓ memory_write/read | ✗ |
| Token savings on idle | ✓ | ✗ |
| Token compaction (scheduled + threshold) | ✓ | ✗ |
| Response time display | ✓ ⏱ Xs | ✗ |
| Web dashboard + live logs | ✓ | ✗ |
| Token usage graph | ✓ Chart.js | ✗ |
| Health endpoint | ✓ GET /health | ✗ |
| Audit log | ✓ JSONL + API | ✗ |
| Remote sessions (SSH) | ✓ | ✗ |
| Auto-backup (7-day) | ✓ backup.sh | ✗ |
| One-command upgrade | ✓ upgrade.sh | ✗ |
| Session migration | ✓ migrate-session.sh | ✗ |
| CI/CD auto-build | ✓ | ✗ |
| Integration tests | ✓ 44 tests | ✗ |

## License

MIT — see [LICENSE](LICENSE)
