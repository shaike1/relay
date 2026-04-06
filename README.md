# Claude Telegram Relay

> Control Claude Code, OpenAI Codex, and GitHub Copilot sessions via Telegram — one forum topic per project, fully webhook-driven.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is this?

A Docker-based orchestration system that maps **Telegram forum topics → AI agent sessions**. Send a message in a topic and the corresponding Claude/Codex/Copilot session responds — with full tool use, inline buttons, file uploads, and peer-to-peer messaging between sessions.

```
You (Telegram) → Relay Bot → Queue File → MCP Server → Claude Code
                                                            ↓
You (Telegram) ←───────────────── send_message ────────────
```

## Features

- **Webhook-driven** — No polling. Instant message delivery via Telegram Bot API webhooks
- **Inline buttons** — Claude can send buttons; clicking shows `✓ label` visual feedback
- **Multi-session** — 16+ concurrent sessions, each isolated in its own Docker container
- **Multi-agent** — Mix Claude, Codex, and Copilot sessions in the same group
- **Peer messaging** — Sessions can message each other (`message_peer`)
- **Task delegation** — Async task queue with dependency support (`send_task` / `complete_task`)
- **Token optimizer** — Detects waste patterns and triggers smart compaction
- **Web dashboard** — Session status, metrics, and web terminal (nomacode)
- **Remote sessions** — Sessions on remote hosts via SSH

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Your Server                         │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  relay-api (port 443 via Caddy)                          │
│  ├── Telegram webhook receiver                           │
│  ├── Web dashboard (/sessions, /metrics)                 │
│  └── Reverse proxy → nomacode (web terminal)             │
│                                                          │
│  relay-session-{name}  (one per Telegram topic)          │
│  ├── Claude Code / Codex / Copilot loop                  │
│  ├── mcp-telegram server (MCP tools for Claude)          │
│  ├── message-watchdog (nudges idle sessions)             │
│  └── token-monitor (token waste detection)               │
│                                                          │
│  Shared: relay-queue volume (/tmp/tg-queue-*.jsonl)      │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Docker + Docker Compose
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- A Telegram supergroup with **Topics enabled**
- Claude Code CLI installed and authenticated
- A domain with HTTPS (Caddy handles TLS automatically)

### Setup

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

# Register Telegram webhook
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://your-domain.com/webhook" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

### Add Sessions

Edit `sessions.json` to define your sessions:

```json
[
  {
    "thread_id": 183,
    "session": "relay",
    "path": "/root/relay",
    "host": null,
    "group": "infra",
    "type": "claude",
    "skills": ["devops", "docker", "general"]
  }
]
```

Then regenerate and restart:

```bash
python3 scripts/generate-compose.py
docker compose -f docker-compose.sessions.yml up -d
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

## Configuration

### `.env`

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather |
| `OWNER_ID` | Your Telegram user ID (admin only) |
| `GROUP_CHAT_ID` | Your supergroup chat ID (negative number) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude OAuth token |

### `sessions.json`

Each entry maps a Telegram topic to a session:

```json
{
  "thread_id": 1234,        // Telegram topic message thread ID
  "session": "my-project",  // Session name (used for container name)
  "path": "/root/my-project", // Working directory
  "host": null,             // null = local, "user@host" = remote SSH
  "group": "dev",           // Logical group
  "type": "claude",         // "claude", "codex", or "copilot"
  "skills": ["python", "api"] // For auto_dispatch routing
}
```

## How It Works

1. User sends a message in a Telegram topic
2. Telegram delivers it to the webhook (`POST /webhook`)
3. `relay-api` writes the message to `/tmp/tg-queue-{THREAD_ID}.jsonl`
4. The session container's `message-watchdog` detects the new entry
5. Claude Code is nudged via tmux to check for new messages
6. Claude calls `fetch_messages` (MCP) → reads the queue
7. Claude does work, then calls `send_message` (MCP) → Telegram

Inline button clicks (`callback_query`) follow the same path, with automatic `answerCallbackQuery` + `editMessageReplyMarkup` for visual `✓` feedback.

## Project Structure

```
relay/
├── relay-api/          # Express.js API + webhook handler
├── mcp-telegram/       # MCP server (TypeScript) — Telegram tools for Claude
├── scripts/            # Session loops, watchdog, utilities
├── caddy/              # Caddyfile for HTTPS reverse proxy
├── s6-overlay-*/       # Process supervision configs
├── session.Dockerfile  # Container image for AI sessions
├── sessions.json       # Session definitions
├── docker-compose.yml  # Core services
└── docker-compose.sessions.yml  # Auto-generated session containers
```

## Comparison

| Feature | This project | ccbot |
|---------|-------------|-------|
| Delivery mode | Webhook (instant) | Polling |
| Inline buttons | ✓ with visual feedback | ✗ |
| Multi-agent | Claude + Codex + Copilot | Claude only |
| Peer messaging | ✓ | ✗ |
| Token optimizer | ✓ | ✗ |
| Web dashboard | ✓ | ✗ |
| Remote sessions | ✓ (SSH) | ✗ |

## License

MIT — see [LICENSE](LICENSE)
