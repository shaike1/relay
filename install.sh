#!/usr/bin/env bash
# relay install script — one-command setup
# Usage: curl -fsSL https://raw.githubusercontent.com/shaike1/relay/main/install.sh | bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[relay]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }
ask()  { echo -e "${BLUE}[?]${NC} $1"; }

RELAY_DIR="${RELAY_DIR:-/root/relay}"
REPO="https://github.com/shaike1/relay.git"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║        Claude Telegram Relay          ║"
echo "  ║  Multi-agent AI sessions via Telegram  ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ── 1. Check prerequisites ────────────────────────────────────────────────────

log "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || err "Docker not found. Install from https://docs.docker.com/engine/install/"
command -v git >/dev/null 2>&1    || err "git not found. Run: apt install git"

DOCKER_COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker compose"
elif docker-compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker-compose"
else
  err "Docker Compose not found. Install Docker Compose v2."
fi

log "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"

# ── 2. Clone / update repo ────────────────────────────────────────────────────

if [ -d "$RELAY_DIR/.git" ]; then
  log "Updating existing installation at $RELAY_DIR..."
  git -C "$RELAY_DIR" pull --ff-only
else
  log "Cloning relay into $RELAY_DIR..."
  git clone "$REPO" "$RELAY_DIR"
fi

cd "$RELAY_DIR"

# ── 3. Configure .env ─────────────────────────────────────────────────────────

if [ -f ".env" ]; then
  warn ".env already exists — skipping interactive setup. Edit manually if needed."
else
  echo ""
  log "Setting up configuration..."
  echo ""

  ask "Telegram Bot Token (from @BotFather):"
  read -r BOT_TOKEN
  [ -z "$BOT_TOKEN" ] && err "Bot token required"

  ask "Your Telegram User ID (from @userinfobot):"
  read -r OWNER_ID
  [ -z "$OWNER_ID" ] && err "Owner ID required"

  ask "Telegram Group Chat ID (negative number, from @getidsbot):"
  read -r GROUP_CHAT_ID
  [ -z "$GROUP_CHAT_ID" ] && err "Group Chat ID required"

  ask "Claude OAuth Token (from ~/.claude.json — value of 'oauthToken'):"
  read -r CLAUDE_TOKEN

  ask "Domain name for HTTPS (e.g. relay.yourdomain.com), or Enter to skip:"
  read -r DOMAIN

  WEBHOOK_SECRET=$(tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 32)
  API_PASS=$(tr -dc 'a-zA-Z0-9-_' < /dev/urandom | head -c 24)

  cat > .env << EOF
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
OWNER_ID=${OWNER_ID}
GROUP_CHAT_ID=${GROUP_CHAT_ID}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}
RELAY_DOMAIN=${DOMAIN:-localhost}
WEBHOOK_SECRET=${WEBHOOK_SECRET}
RELAY_API_PASS=${API_PASS}
EOF

  log ".env created"

  # Create default sessions.json
  if [ ! -f "sessions.json" ]; then
    cat > sessions.json << EOF
[
  {
    "thread_id": 1,
    "session": "main",
    "path": "${RELAY_DIR}",
    "host": null,
    "group": "infra",
    "type": "claude",
    "skills": ["devops", "docker", "general"]
  }
]
EOF
    warn "Created default sessions.json — update thread_id to your Telegram topic ID"
  fi
fi

# ── 4. Docker network and volume ──────────────────────────────────────────────

log "Setting up Docker network and volumes..."
docker network create relay_default 2>/dev/null || true
docker volume create relay-queue 2>/dev/null || true

# ── 5. Build images ───────────────────────────────────────────────────────────

log "Building relay bot image (this takes a few minutes)..."
docker build -t topix-relay:latest -f Dockerfile . --quiet

log "Building session image..."
docker build -t relay-session:latest -f session.Dockerfile . --quiet

# ── 6. Generate session containers ───────────────────────────────────────────

log "Generating session docker-compose..."
python3 scripts/generate-compose.py

# ── 7. Start services ─────────────────────────────────────────────────────────

log "Starting core services..."
$DOCKER_COMPOSE_CMD up -d relay relay-nomacode relay-api

log "Starting session containers..."
$DOCKER_COMPOSE_CMD -f docker-compose.sessions.yml up -d

# ── 8. Register Telegram webhook ──────────────────────────────────────────────

# shellcheck source=/dev/null
source .env

if [ -n "${RELAY_DOMAIN:-}" ] && [ "$RELAY_DOMAIN" != "localhost" ]; then
  log "Registering Telegram webhook..."
  WEBHOOK_URL="https://${RELAY_DOMAIN}/webhook"
  RESPONSE=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -d "url=${WEBHOOK_URL}" \
    -d "secret_token=${WEBHOOK_SECRET:-}" \
    -d 'allowed_updates=["message","callback_query"]')
  if echo "$RESPONSE" | grep -q '"ok":true'; then
    log "Webhook registered: $WEBHOOK_URL"
  else
    warn "Webhook registration failed: $RESPONSE"
    warn "Register manually after setup."
  fi
else
  warn "No domain set — skipping webhook registration."
  warn "After pointing a domain, run: bash scripts/register-webhook.sh"
fi

# ── 9. Done ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  relay is running!${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
# shellcheck disable=SC2153
echo "  Dashboard:  https://${RELAY_DOMAIN:-localhost}/sessions"
echo "  Logs:       docker logs relay -f"
echo "  Status:     docker ps --filter name=relay"
echo ""
echo "  Next steps:"
echo "  1. Edit sessions.json — set correct thread_id for each Telegram topic"
echo "  2. Add .mcp.json to each project directory (see docs)"
echo "  3. Send a message in your Telegram topic"
echo ""
