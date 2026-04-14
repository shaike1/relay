# Telegram-Claude Relay System

## Overview

Multi-agent Claude Code system controlled via Telegram forum topics. Each topic = isolated Claude session with persistent memory. Users interact exclusively through Telegram — Claude cannot see terminal I/O directly.

**Core principle**: Queue-based async messaging. Telegram bot writes to JSONL queue → MCP server reads queue → Claude processes → Claude calls MCP tools to reply → Response appears in Telegram.

---

## Architecture Components

### 1. Telegram Bot (`bot.py`)
- Python-Telegram-Bot application running as systemd service
- Handles webhook or polling for Telegram updates
- Routes messages to per-topic queue files: `/tmp/tg-queue-{thread_id}.jsonl`
- Manages session lifecycle (create/attach/restart)
- Tracks state in `/tmp/tg-queue-{thread_id}.state` (lastId, ackedForce)
- Provisions tmux sessions via `claude-session-loop.sh`

**Key functions**:
- `write_queue(thread_id, message, host)` — append message to queue (local or SSH)
- `_bootstrap_state_files()` — on startup, create state files for queues with stale messages (>24h) to prevent restart loops
- `check_no_reply()` — watchdog that alerts if session hasn't responded in 2h

### 2. MCP Telegram Server (`mcp-telegram/server.ts`)
- Bun-based MCP server running inside each Claude session container
- Launched via `mcp-server-wrapper.sh` (auto-restart loop)
- Reads from `/tmp/tg-queue-{THREAD_ID}.jsonl` (via shared volume or SSH pull)
- Provides MCP tools: `send_message`, `fetch_messages`, `send_code`, `send_form`, `react`, etc.
- Sends messages to Telegram via Bot API
- Maintains SQLite database for message history, tasks, memory, knowledge
- Creates lock file `/tmp/tg-queue-{THREAD_ID}.lock` with PID

**Message flow**:
1. `fetch_messages` tool reads queue file, filters by `lastId` in state file
2. Returns new messages to Claude
3. Claude calls `send_message` → MCP makes Telegram API call
4. State file updated with new `lastId`

**Notification system**:
- MCP uses `dbWarmFromQueue()` on startup to load unprocessed messages into SQLite
- Claude Code notification channel: `notifications/claude/channel`
- Force messages (system prompts, alerts) use `deliveredForce: Infinity` to bypass lastId check
- `ackedForce` array tracks acknowledged force messages (pruned to 2h retention)

### 3. Message Watchdog (`message-watchdog.sh`)
- Runs inside each session container (started by `claude-session-loop.sh`)
- Polls queue file every 5 seconds for new messages
- If Claude idle + pending messages → nudge via tmux `send-keys`
- **MCP health check** (every 3s):
  - Detects if Claude running but MCP missing
  - Extracts MCP PID from lock file `/tmp/tg-queue-{THREAD_ID}.lock`
  - Validates PID is alive via `kill -0`
  - If MCP dead: kill Claude (triggers restart via tmux respawn) with exponential backoff
- Loop detection: tracks consecutive identical tool call hashes, alerts if >5 cycles
- Auto-compact: triggers `/compact` if input tokens > threshold
- Crash alerts: notifies if session silent >30min (configurable via `CRASH_ALERT_MINUTES`)

### 4. Session Loop (`claude-session-loop.sh`)
- Tmux-based session manager
- Creates tmux session with per-session socket: `/tmp/tmux-{SESSION}.sock`
- Launches Claude Code in tmux pane with `respawn-pane` (auto-restart on exit)
- Launches MCP wrapper in background via `mcp-server-wrapper.sh`
- Launches message watchdog via `message-watchdog.sh`
- Handles WORKDIR override via `/tmp/relay-session-env-{THREAD_ID}`

### 5. Relay API (`relay-api/server.js`)
- Express.js API on port 9100
- Serves dashboard, metrics, session management endpoints
- Proxies to Nomacode, OmniRoute, other services
- **Button click webhook** (`/webhook/callback`):
  - Telegram inline button clicks arrive here
  - Writes button label as message to queue (local or remote via `/push`)
  - Answers callback query to update button UI
- **Remote push** (`/push`):
  - Accepts queue messages from remote relay-api instances
  - Validates `x-push-secret` header
  - Writes to local queue file
- **Restart command** (`handleRestartCommand`):
  - Supports remote sessions via SSH `docker restart`

### 6. Sessions Watchdog (`sessions-watchdog.sh`)
- System-level watchdog (runs on host, not per-session)
- Reads `sessions.json`, ensures tmux session exists for each entry
- Creates missing sessions via `claude-session-loop.sh`
- Periodic nudge to idle sessions: "Call mcp__telegram__fetch_messages..."

---

## Data Flow: User Message → Claude Response

```
1. User types in Telegram topic
   ↓
2. bot.py receives update (webhook or polling)
   ↓
3. bot.py appends to /tmp/tg-queue-{thread_id}.jsonl
   {
     "message_id": 14810,
     "text": "Hi",
     "sender": "Shai",
     "ts": 1713038425.915
   }
   ↓
4. message-watchdog.sh detects new entry (via mtime or line count)
   ↓
5. If Claude idle >5s + pending messages:
      tmux send-keys "You have a pending message. Call mcp__telegram__fetch_messages..."
   ↓
6. Claude wakes, calls fetch_messages MCP tool
   ↓
7. MCP server.ts reads queue, filters by lastId from state file, returns new messages
   ↓
8. Claude processes, calls send_message("Response text")
   ↓
9. MCP server.ts POSTs to Telegram Bot API sendMessage
   ↓
10. User sees response in Telegram
   ↓
11. State file updated: lastId = 14810
```

---

## State Files

### Queue File: `/tmp/tg-queue-{thread_id}.jsonl`
- Append-only JSONL log of all messages for this topic
- Each entry: `{message_id, text, sender, ts, force?, reply_to?, ...}`
- Never truncated (MCP relies on reading full file to build SQLite history)

### State File: `/tmp/tg-queue-{thread_id}.state`
- JSON: `{lastId: 14810, ackedForce: [1713038400000, ...]}`
- `lastId`: highest message_id processed by Claude
- `ackedForce`: timestamps of acknowledged force messages (pruned to 2h)
- **Bootstrap logic** (bot.py startup):
  - If queue has stale messages (>24h) but no state file → create state with `lastId = max(message_id)`
  - Prevents endless restart loops from old unprocessed messages

### Lock File: `/tmp/tg-queue-{thread_id}.lock`
- Contains MCP server PID
- Created by `server.ts` on startup
- Deleted on clean shutdown (only if PID matches)
- Used by message-watchdog to detect MCP crashes

### Override Env: `/tmp/relay-session-env-{thread_id}`
- Shell script sourced by `message-watchdog.sh` and `claude-session-loop.sh`
- Overrides env vars per session (e.g., `WORKDIR=/custom/path`)
- Managed by relay-api or bot.py during session provisioning

---

## Common Issues & Fixes

### Issue 1: MCP crashes → Claude stops responding
**Symptoms**: User messages appear in queue but Claude doesn't reply. No lock file or stale lock file PID.

**Root causes**:
1. MCP crashes due to unhandled exception (e.g., Telegram API timeout)
2. Lock file not cleaned up → watchdog can't detect crash
3. Multiple MCP instances fighting over queue (race condition)

**Fixes**:
- ✅ Lock file cleanup: only delete if PID matches (commit cd371e4)
- ✅ MCP wrapper flock: prevent duplicate instances (commit cd371e4)
- ✅ Watchdog PID validation: `kill -0 $mcp_pid` instead of `pgrep` (commit cd371e4)

### Issue 2: Stale messages trigger infinite restart loops
**Symptoms**: Session restarts every 3s, watchdog log: "MCP missing, restarting..."

**Root cause**: Queue has messages from days ago. State file missing → MCP thinks all messages are new → notifies Claude → Claude already exited → restart loop.

**Fix**:
- ✅ Bootstrap state files on bot.py startup (commit cd371e4)
- ✅ Watchdog skips stale messages (>24h) in no-reply check (commit cd371e4)

### Issue 3: Button clicks don't reach Claude
**Symptoms**: User clicks inline button, nothing happens or "Callback query failed".

**Root causes**:
1. Webhook endpoint not receiving callback_query updates
2. Queue write fails (disk full, SSH timeout)
3. Remote session: button click routed to wrong host

**Fixes**:
- ✅ Button callbacks routed via remote push API (commit cd371e4)
- ✅ Answer callback query immediately to prevent timeout (existing)
- TODO: Validate button clicks arrive in queue (check queue file after click)

### Issue 4: Claude doesn't fetch messages after startup
**Symptoms**: Session starts, logs "Back online", but doesn't process pending messages.

**Root cause**: CLAUDE.md missing step 4 → Claude replies once but never calls `fetch_messages` again.

**Fix**:
- ✅ Updated CLAUDE.md/CLAUDE_TEMPLATE.md with step 4: "Call fetch_messages after every reply" (commit cd371e4)

### Issue 5: Remote sessions can't be restarted
**Symptoms**: `/restart` command fails for remote sessions with "docker: command not found" or SSH timeout.

**Fix**:
- ✅ Restart command uses SSH for remote sessions: `ssh {host} docker restart {container}` (commit cd371e4)

---

## Debugging Checklist

When a session is stuck:

1. **Check if Claude is running**:
   ```bash
   docker exec relay-session-{name} pgrep claude
   ```

2. **Check if MCP is running**:
   ```bash
   docker exec relay-session-{name} cat /tmp/tg-queue-{thread_id}.lock
   docker exec relay-session-{name} kill -0 $(cat /tmp/tg-queue-{thread_id}.lock)
   ```

3. **Check queue for new messages**:
   ```bash
   docker exec relay-session-{name} tail -5 /tmp/tg-queue-{thread_id}.jsonl
   ```

4. **Check state file**:
   ```bash
   docker exec relay-session-{name} cat /tmp/tg-queue-{thread_id}.state
   ```

5. **Check watchdog logs**:
   ```bash
   docker logs relay-session-{name} 2>&1 | grep watchdog | tail -20
   ```

6. **Check MCP logs**:
   ```bash
   docker logs relay-session-{name} 2>&1 | grep mcp-wrapper | tail -20
   ```

7. **Force restart Claude** (watchdog will restart MCP):
   ```bash
   docker exec relay-session-{name} pkill claude
   ```

8. **Full container restart**:
   ```bash
   docker restart relay-session-{name}
   ```

---

## Environment Variables (Key)

### Bot (`bot.py`)
- `TELEGRAM_BOT_TOKEN` — bot token
- `GROUP_CHAT_ID` — supergroup chat ID (negative number)
- `OWNER_ID` — Telegram user ID of owner
- `SESSIONS_FILE` — path to sessions.json (default: `/relay/sessions.json`)

### MCP Server (`server.ts`)
- `TELEGRAM_BOT_TOKEN` — bot token
- `TELEGRAM_CHAT_ID` — supergroup chat ID
- `TELEGRAM_THREAD_ID` — forum topic thread ID (unique per session)
- `SESSION_NAME` — session identifier (e.g., "relay", "ha")

### Watchdog (`message-watchdog.sh`)
- `TELEGRAM_THREAD_ID` — thread ID
- `SESSION_NAME` — session name
- `AUTO_COMPACT_THRESHOLD` — input tokens before auto /compact (default: 80000)
- `CRASH_ALERT_MINUTES` — alert if silent >N min (default: 30)
- `LOOP_DETECT_ENABLED` — enable loop detection (default: 1)

### Session Loop (`claude-session-loop.sh`)
- `SESSION_NAME` — session name
- `TELEGRAM_THREAD_ID` — thread ID
- `WORKDIR` — working directory override (default: per session config)

---

## Recent Improvements (commit cd371e4)

1. **Bootstrap state files** — prevents stale queue restart loops
2. **MCP lock cleanup** — only delete lock if PID matches (prevents false crash detection)
3. **MCP wrapper flock** — prevents duplicate MCP instances
4. **Targeted PID detection** — watchdog extracts claude/mcp PIDs from tmux pane tree, not global `pgrep`
5. **Button click routing** — remote sessions receive clicks via push API
6. **Remote restart support** — SSH-based docker restart for remote sessions
7. **IPv4 DNS preference** — force Node to prefer IPv4 (containers have broken IPv6 routes)
8. **Explicit tool names** — nudges use `mcp__telegram__fetch_messages` (not just "fetch_messages")
9. **CLAUDE.md step 4** — always call `fetch_messages` after replying (continuous message flow)

---

## Known Limitations

1. **Queue file never truncated** — grows unbounded. Not an issue in practice (JSONL is append-only, MCP reads efficiently).
2. **No message deduplication** — if bot.py writes same message twice, Claude sees it twice. Mitigated by state file `lastId` tracking.
3. **Force messages expire** — `ackedForce` pruned to 2h. Very old force messages may re-trigger.
4. **MCP restart backoff caps at 60s** — aggressive sessions may still restart too often. Consider raising cap.
5. **Remote queue pull not implemented** — MCP server can't pull from remote relay-api yet (only local queue or SSH-mounted volume). Button clicks work via push API, but initial queue sync requires shared volume.

---

## Sessions.json Schema

```json
[
  {
    "thread_id": 183,
    "session": "relay",
    "path": "/relay",
    "host": null,
    "group": "infra",
    "description": "Main relay platform session",
    "skills": ["relay", "infra", "docker"],
    "env": {
      "ANTHROPIC_BASE_URL": "http://100.64.0.7:20129",
      "AUTO_COMPACT_THRESHOLD": "40000"
    },
    "protected": true
  }
]
```

**Fields**:
- `thread_id` — Telegram forum topic ID (unique)
- `session` — tmux session name (unique)
- `path` — working directory
- `host` — SSH host for remote sessions (null = local)
- `group` — grouping tag (e.g., "infra", "iot")
- `description` — human-readable description
- `skills` — keyword list for auto-routing
- `env` — environment variable overrides injected into container
- `protected` — if true, prevent accidental deletion
- `skills_route` — if true, enable auto-routing based on skills keywords
- `allowed_users` — list of Telegram user IDs allowed to interact (null = owner only)

---

## Next Steps / TODOs

- [ ] Implement remote queue pull (MCP server fetches from relay-api instead of relying on shared volume)
- [ ] Add queue compaction (archive old messages, keep last 1000)
- [ ] Improve loop detection (track tool sequence patterns, not just hashes)
- [ ] Add per-session health dashboard (uptime, message count, error rate)
- [ ] Implement graceful MCP shutdown (SIGTERM handler, wait for in-flight messages)
- [ ] Add retry logic for Telegram API calls in MCP (currently fails silently on timeout)

---

## Contact / Handoff Notes

**For openclaw or other contributors**:

- Primary entry point: `bot.py` (handles all Telegram updates)
- MCP server is authoritative for message state (SQLite db, not state file)
- State file is a **cache** — MCP rebuilds from queue on startup
- Watchdog is **aggressive** — restart MCP on any sign of trouble
- Always test changes in a non-protected session first (e.g., create a test topic)
- Check logs via `docker logs relay-session-{name}` — all components write to stdout/stderr
- If stuck, restart container — MCP will rebuild state from queue

**Recent pain points**:
1. Lock file cleanup race condition → fixed via PID matching
2. Duplicate MCP instances → fixed via flock in wrapper
3. Stale messages causing restart loops → fixed via bootstrap + 24h threshold
4. Button clicks not routing to remote sessions → fixed via push API

**Safe to modify**:
- `sessions.json` — add/remove sessions (sessions-watchdog auto-syncs)
- CLAUDE.md — session behavior instructions
- Watchdog intervals/thresholds (via env vars)

**Dangerous to modify**:
- Queue file format (breaks MCP parsing)
- State file schema (breaks lastId tracking)
- Lock file PID format (breaks watchdog detection)
- MCP tool signatures (breaks Claude Code integration)
