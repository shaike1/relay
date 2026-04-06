# Claude Telegram Relay

> Run Claude Code, Codex, and Copilot as **persistent, containerized agents** — controlled from Telegram, Discord, or WhatsApp. One topic per project. No polling. No babysitting.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/shaike1/relay)](https://github.com/shaike1/relay/releases)

**Step away from your computer. Your AI agents keep working — and you stay in control from your phone.**

## What is this?

A Docker-based orchestration system that maps **Telegram forum topics → AI agent sessions**. Send a message in a topic and the corresponding Claude/Codex/Copilot session responds — with full tool use, inline buttons, voice transcription, file uploads, and peer-to-peer messaging between sessions.

```
You (Telegram/Discord/WhatsApp) → Relay → Queue → MCP → Claude Code
                                                              ↓
You ←─────────────────────────── send_message ───────────────
```

## Features

### Core
- **Webhook-driven** — No polling. Instant delivery via Telegram Bot API webhooks
- **Multi-session** — 16+ concurrent sessions, each isolated in its own Docker container
- **Multi-agent** — Mix Claude Code, OpenAI Codex, and GitHub Copilot in the same group
- **Inline buttons** — Claude sends buttons; clicking shows `✓ label` visual feedback
- **Button callbacks** — Clicking always reaches Claude (fixed force-delivery)

### Messaging & Media
- **Voice messages** — Auto-transcribed via OpenAI Whisper API; fallback saves to `/tmp`
- **Photos/images** — Downloaded to `/tmp`, path sent to Claude for analysis
- **Reaction commands** — 👍=Continue 🔁=Retry ❌=Cancel ✅=Confirm 🚀=Deploy 🛑=Stop 💡=Implement 🤔=Explain
- **Multi-platform bridges** — Discord (bidirectional) and WhatsApp (bidirectional, QR auth)

### Agent Control
- **Real-time tool monitoring** — See every `Bash`/`Read`/`Edit`/`Write` call in Telegram as it happens
- **Live streaming** — Pane content streamed every 2s while Claude works; deleted on completion
- **Session crash alerts** — Auto-alert after N minutes of silence (configurable)
- **Context compaction alerts** — Notified before context is compacted
- **Context handoff** — On restart, Claude automatically receives the last session summary
- **Startup token savings** — Only wakes Claude when there are pending messages

### Commands (no Claude tokens)
- `/status` — Container health for all sessions
- `/history [page]` — Paginated message history (12/page, prev/next buttons)
- `/stats` — Token usage + USD cost breakdown (today + cumulative)
- `/template [name]` — List or apply session templates

### Scheduling & Automation
- **Scheduled tasks** — Cron-like scheduler (`schedules.json`, 5-field cron expressions)
- **Auto-summary** — Daily session summaries via `auto-summary.sh` + scheduler
- **Plugin/Skills system** — Per-session skill files injected into `CLAUDE.md` at startup
- **Session templates** — Pre-configured `devops`, `fullstack` (extensible)

### Infrastructure
- **Peer messaging** — Sessions message each other (`message_peer`)
- **Task delegation** — Async task queue with skill-based routing (`send_task` / `complete_task`)
- **Multi-tenant** — Per-user session isolation (`multi_tenant: true` in sessions.json)
- **Token optimizer** — Waste detection + smart compaction triggers
- **Web dashboard** — Session status, metrics, web terminal, live logs, tool call timeline
- **Remote sessions** — Sessions on remote hosts via SSH
- **CI/CD** — GitHub Actions auto-builds and pushes session image on every push
- **MCP auto-restart** — Watchdog detects missing MCP server and restarts session

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Your Server                           │
├──────────────────────────────────────────────────────────────┤
│  relay-api (port 443 via Caddy)                               │
│  ├── Telegram/Discord/WhatsApp webhook receivers              │
│  ├── /status /history /stats /template commands               │
│  ├── Cron scheduler (schedules.json)                          │
│  ├── Web dashboard + live logs (SSE) + tool timeline          │
│  └── Reverse proxy → nomacode (web terminal)                  │
│                                                               │
│  discord-bridge (profile: discord)  :9102                     │
│  whatsapp-bridge (profile: whatsapp) :9103                    │
│                                                               │
│  relay-session-{name}  (one per Telegram topic)               │
│  ├── Claude Code / Codex / Copilot loop                       │
│  ├── mcp-telegram server (MCP tools for Claude)               │
│  ├── message-watchdog (nudges + tool monitor + streaming)     │
│  └── token-logger (Stop hook → /tmp/token-stats-*.jsonl)      │
│                                                               │
│  Shared: relay-queue volume (/tmp/tg-queue-*.jsonl)           │
└──────────────────────────────────────────────────────────────┘
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

### Enable Discord or WhatsApp

```bash
# Discord bridge
echo "DISCORD_BOT_TOKEN=..." >> .env
docker compose --profile discord up -d discord-bridge

# WhatsApp bridge (QR code sent to Telegram)
echo "DISCORD_BOT_TOKEN=..." >> .env
docker compose --profile whatsapp up -d whatsapp-bridge
```

## MCP Tools Available to Claude

| Tool | Description |
|------|-------------|
| `send_message` | Send HTML message with optional inline buttons |
| `fetch_messages` | Read recent messages from the topic queue |
| `typing` | Show typing indicator |
| `send_file` | Upload file to Telegram |
| `edit_message` | Edit a previously sent message |
| `react` | Add emoji reaction to a message |
| `list_peers` | List all active sessions |
| `message_peer` | Send a message to another session |
| `send_task` | Delegate async task to a session |
| `complete_task` | Return task result |
| `auto_dispatch` | Route task to best session by skill match |
| `knowledge_read` | Read from shared knowledge base |
| `knowledge_write` | Write to shared knowledge base |
| `get_session_context` | Get context of another session |
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
| Real-time tool monitoring | ✓ | ✗ |
| Live pane streaming | ✓ | ✗ |
| Session crash alerts | ✓ | ✗ |
| PreCompact notifications | ✓ | ✗ |
| Context handoff on restart | ✓ | ✗ |
| /status (no tokens) | ✓ | ✗ |
| /history pagination | ✓ | ✗ |
| /stats token + cost | ✓ | ✗ |
| /template session templates | ✓ | ✗ |
| Scheduled tasks (cron) | ✓ | ✗ |
| Plugin/skills system | ✓ | ✗ |
| Multi-tenant per-user | ✓ | ✗ |
| Peer messaging | ✓ | ✗ |
| Task delegation + routing | ✓ | ✗ |
| Token savings on idle | ✓ | ✗ |
| Web dashboard + live logs | ✓ | ✗ |
| Remote sessions (SSH) | ✓ | ✗ |
| CI/CD auto-build | ✓ | ✗ |

## License

MIT — see [LICENSE](LICENSE)
