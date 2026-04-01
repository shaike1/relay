# Relay Hub — Web Terminal Interface

A browser-based session manager for all relay Claude sessions, accessible from anywhere via HTTPS.

## Access

| URL | Auth |
|-----|------|
| https://relay.right-api.com | Username: `relay` · Password: `relay2026` |
| http://100.64.0.7:7070 | Tailscale only (no auth required) |

## What is Relay Hub?

Relay Hub is a web terminal that shows all Claude relay sessions across both servers and lets you attach to any of them from your browser — no SSH needed.

It runs as the `nomacode` Docker container and uses `hub.sh` as its shell.

## Session Menu

When you open the hub, you see a menu like this:

```
╔══════════════════════════════════════════╗
║           RELAY SESSION HUB              ║
╚══════════════════════════════════════════╝

  LOCAL (100.64.0.7):
   1) claude-runner          [running]
   2) clawdbot               [running]
   3) relay                  [running]
   ...

  REMOTE (root@100.64.0.12):
   8) duplicacy              [remote]
   9) edushare               [remote]
  10) headscale              [remote]
  11) right-api-web          [remote]
  12) teamy                  [remote]

  r) Refresh    q) Quit
```

- **LOCAL** — relay session containers running on 100.64.0.7
- **REMOTE** — relay session containers running on 100.64.0.12

Select a number to attach to that session's tmux pane (you see Claude's live output).
Press `Ctrl+B d` to detach and return to the menu.

## Architecture

```
Browser → https://relay.right-api.com → Caddy (TLS) → nomacode:3000 → hub.sh (PTY) → docker exec → tmux session
```

- **Caddy** handles TLS and proxies to `nomacode` container
- **nomacode** provides the web terminal (xterm.js + WebSocket)
- **hub.sh** (`/root/relay/scripts/hub.sh`) is the shell — lists sessions and handles selection
- Each session runs as a Docker container (`relay-session-<name>`)

## Infrastructure

| Component | Host | Container | Port |
|-----------|------|-----------|------|
| nomacode web terminal | 100.64.0.7 | `nomacode` | 7070 (host) / 3000 (internal) |
| Caddy HTTPS proxy | 100.64.0.7 | `caddy` | 443 |
| Local sessions | 100.64.0.7 | `relay-session-*` | — |
| Remote sessions | 100.64.0.12 | `relay-session-*` | — |

## hub.sh Details

Location: `/root/relay/scripts/hub.sh`

Key behaviors:
- **Non-interactive SSH** (e.g. `ssh host "cmd"`): exits immediately via `-c` flag handler or no-TTY fallback — does **not** show the menu
- **Interactive SSH / web terminal**: shows the session picker menu
- `RELAY_REMOTE_HOST` env var controls which server is listed as REMOTE (default: `root@100.64.0.12`)

### Remote session listing

hub.sh SSH-es to `$RELAY_REMOTE_HOST` to list containers:
```bash
ssh root@100.64.0.12 "docker ps --format '{{.Names}}' | grep relay-session-"
```

**Important:** The `.bashrc` on `100.64.0.12` must have an interactive guard to prevent hub.sh from blocking non-interactive SSH:
```bash
if [ -z "$TMUX" ] && [ -n "$SSH_CONNECTION" ] && [[ $- == *i* ]] && command -v docker &>/dev/null; then
    exec env RELAY_REMOTE_HOST=root@100.64.0.7 /root/relay/scripts/hub.sh
fi
```
Without `[[ $- == *i* ]]`, `list_remote()` would hang indefinitely.

## Starting / Restarting

```bash
# Start nomacode (from relay dir)
docker compose -f docker-compose.nomacode.yml up -d

# Restart
docker restart nomacode

# Logs
docker logs nomacode -f
```

## Credentials

Stored in `docker-compose.nomacode.yml` as environment variables:
- `NOMACODE_USER=relay`
- `NOMACODE_PASS=relay2026`

To change: update the compose file and restart nomacode.
