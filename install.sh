#!/usr/bin/env bash
set -e

# Topix Relay install script
# https://github.com/shaike1/relay

RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$RELAY_DIR/mcp-telegram"
ENV_FILE="$RELAY_DIR/.env"
MCP_ENV_DIR="$HOME/.claude/channels/telegram"
SERVICE_NAME="relay"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}▶${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }
die()     { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
ask()     { echo -en "${YELLOW}?${NC} $* "; }

echo ""
echo "  Topix Relay — Telegram to Claude Code bridge"
echo "  https://github.com/shaike1/relay"
echo ""

# ── 0. Docker fast-path ───────────────────────────────────────────────────────

if command -v docker &>/dev/null && command -v docker compose &>/dev/null 2>/dev/null; then
  echo -n "  Docker is available. Install with Docker instead of systemd? [Y/n] "
  read -r USE_DOCKER
  USE_DOCKER="${USE_DOCKER:-Y}"
  if [[ "$USE_DOCKER" =~ ^[Yy]$ ]]; then
    info "Using Docker..."

    # Write .env if missing
    if [ ! -f "$ENV_FILE" ]; then
      info "Configuring..."
      ask "TELEGRAM_BOT_TOKEN:"; read -r BOT_TOKEN
      ask "OWNER_ID:"; read -r OWNER_ID
      ask "GROUP_CHAT_ID:"; read -r GROUP_CHAT_ID
      printf "TELEGRAM_BOT_TOKEN=%s\nOWNER_ID=%s\nGROUP_CHAT_ID=%s\n" \
        "$BOT_TOKEN" "$OWNER_ID" "$GROUP_CHAT_ID" > "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      info ".env written"
    fi

    docker compose up -d
    echo ""
    echo "  ✓ Topix Relay is running in Docker"
    echo "  Logs: docker compose logs -f"
    echo ""
    exit 0
  fi
fi

# ── 1. Python deps ────────────────────────────────────────────────────────────

info "Installing Python dependencies..."
pip install --quiet python-telegram-bot[job-queue]==21.6
echo "   python-telegram-bot installed"

# ── 2. Bun ───────────────────────────────────────────────────────────────────

if ! command -v bun &>/dev/null; then
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Ensure bun is in system PATH (required for Claude Code MCP spawning)
BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
if [ "$BUN_BIN" != "/usr/local/bin/bun" ]; then
  info "Symlinking bun to /usr/local/bin/bun..."
  sudo ln -sf "$BUN_BIN" /usr/local/bin/bun
fi
echo "   bun: $(bun --version) at $(which bun)"

# ── 3. MCP server deps ────────────────────────────────────────────────────────

info "Installing MCP server dependencies..."
cd "$MCP_DIR" && bun install --frozen-lockfile --silent
cd "$RELAY_DIR"
echo "   MCP server ready"

# ── 4. Relay .env ─────────────────────────────────────────────────────────────

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — skipping (delete it to reconfigure)"
else
  info "Configuring Topix Relay..."
  echo ""
  echo "   You'll need:"
  echo "   • Bot token from @BotFather"
  echo "   • Your Telegram user ID (send /start to @userinfobot)"
  echo "   • Group chat ID (negative number from getUpdates)"
  echo ""

  ask "TELEGRAM_BOT_TOKEN:"; read -r BOT_TOKEN
  ask "OWNER_ID (your Telegram user ID):"; read -r OWNER_ID
  ask "GROUP_CHAT_ID (supergroup ID):"; read -r GROUP_CHAT_ID

  cat > "$ENV_FILE" <<EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
OWNER_ID=$OWNER_ID
GROUP_CHAT_ID=$GROUP_CHAT_ID
EOF
  chmod 600 "$ENV_FILE"
  echo ""
  info ".env written"
fi

# ── 5. MCP credentials ────────────────────────────────────────────────────────

MCP_ENV_FILE="$MCP_ENV_DIR/.env"
if [ -f "$MCP_ENV_FILE" ]; then
  warn "$MCP_ENV_FILE already exists — skipping"
else
  mkdir -p "$MCP_ENV_DIR"
  # Re-use values from relay .env if available
  source "$ENV_FILE" 2>/dev/null || true
  if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$GROUP_CHAT_ID" ]; then
    ask "TELEGRAM_BOT_TOKEN (for MCP server):"; read -r TELEGRAM_BOT_TOKEN
    ask "GROUP_CHAT_ID (for MCP server):"; read -r GROUP_CHAT_ID
  fi
  cat > "$MCP_ENV_FILE" <<EOF
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$GROUP_CHAT_ID
EOF
  chmod 600 "$MCP_ENV_FILE"
  info "MCP credentials written to $MCP_ENV_FILE"
fi

# ── 6. systemd service ────────────────────────────────────────────────────────

if [ -f "$SERVICE_FILE" ]; then
  warn "$SERVICE_FILE already exists — skipping"
else
  if ! command -v systemctl &>/dev/null; then
    warn "systemd not found — skipping service setup. Run manually: python $RELAY_DIR/bot.py"
  else
    info "Installing systemd service..."
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Topix Relay — Telegram to Claude Code bridge
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$RELAY_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v python3) $RELAY_DIR/bot.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    sudo systemctl start "$SERVICE_NAME"
    echo "   Service enabled and started"
  fi
fi

# ── 7. Summary ────────────────────────────────────────────────────────────────

echo ""
echo "  ✓ Topix Relay is installed and running"
echo ""
echo "  Next: add a project"
echo "    Send /new /path/to/your/project in your Telegram group"
echo ""
echo "  Or wire up an existing project manually:"
echo "    Copy this into your project's .mcp.json:"
echo ""
echo '    {'
echo '      "mcpServers": {'
echo '        "telegram": {'
echo '          "command": "bun",'
echo "          \"args\": [\"run\", \"--cwd\", \"$MCP_DIR\", \"--silent\", \"start\"],"
echo '          "env": { "TELEGRAM_THREAD_ID": "YOUR_THREAD_ID" }'
echo '        }'
echo '      }'
echo '    }'
echo ""
echo "  Copy CLAUDE_TEMPLATE.md to your project's CLAUDE.md"
echo "  Then: cd /your/project && claude"
echo ""
echo "  Logs: journalctl -u relay -f"
echo ""
