#!/usr/bin/env bash
# Register the Telegram webhook after install
set -euo pipefail

cd "$(dirname "$0")/.."
source .env

DOMAIN="${RELAY_DOMAIN:-}"
[ -z "$DOMAIN" ] && { echo "Error: RELAY_DOMAIN not set in .env"; exit 1; }

WEBHOOK_URL="https://${DOMAIN}/webhook"
SECRET="${WEBHOOK_SECRET:-}"

echo "Registering webhook: $WEBHOOK_URL"

RESPONSE=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_URL}" \
  ${SECRET:+-d "secret_token=${SECRET}"} \
  -d 'allowed_updates=["message","callback_query"]')

echo "$RESPONSE" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('ok'):
    print('✓ Webhook registered:', '${WEBHOOK_URL}')
else:
    print('✗ Failed:', r.get('description', 'unknown error'))
    sys.exit(1)
"
