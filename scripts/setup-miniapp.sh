#!/bin/bash
# Setup Telegram Mini App with BotFather
# Run this once to register the Mini App URL with your bot.

DOMAIN="${MINIAPP_DOMAIN:-${WEBHOOK_URL%%/webhook*}}"
if [ -z "$DOMAIN" ]; then
  DOMAIN="https://relay.right-api.com"
fi
MINIAPP_URL="${DOMAIN}/miniapp"

echo "=============================="
echo " Relay Telegram Mini App Setup"
echo "=============================="
echo ""
echo "Mini App URL: $MINIAPP_URL"
echo ""
echo "To register the Mini App with BotFather:"
echo ""
echo "  Option A — Set as Menu Button (recommended):"
echo "    1. Message @BotFather"
echo "    2. Send: /mybots"
echo "    3. Choose your bot"
echo "    4. Bot Settings → Menu Button → Configure menu button"
echo "    5. Send the URL: $MINIAPP_URL"
echo ""
echo "  Option B — Create a new Mini App:"
echo "    1. Message @BotFather"
echo "    2. Send: /newapp"
echo "    3. Follow the prompts"
echo "    4. Set Web App URL to: $MINIAPP_URL"
echo ""
echo "  Option C — Set via Bot API (automated):"
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  echo "    Running setChatMenuButton via API..."
  RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton" \
    -H "Content-Type: application/json" \
    -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Open App\",\"web_app\":{\"url\":\"${MINIAPP_URL}\"}}}")
  echo "    Result: $RESULT"
else
  echo "    Set TELEGRAM_BOT_TOKEN env var to use automated setup."
fi
echo ""
echo "The Mini App will be accessible from the bot's menu button (hamburger icon)."
echo "Direct URL: $MINIAPP_URL"
