#!/usr/bin/env bash
# sync-driver-to-remote.sh — copy session-driver.py to all remote containers on .12
# Run after any change to session-driver.py
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRIVER="$SCRIPT_DIR/session-driver.py"

REMOTE_CONTAINERS=(
  relay-session-edushare
  relay-session-teamy
  relay-session-right-api-web
  relay-session-headscale
  relay-session-duplicacy
)

echo "[sync] Syncing session-driver.py to remote containers on .12..."
for c in "${REMOTE_CONTAINERS[@]}"; do
  if docker ps -q --filter "name=^${c}$" | grep -q .; then
    docker cp "$DRIVER" "$c:/relay/scripts/session-driver.py" && echo "[sync] ✅ $c" || echo "[sync] ❌ $c"
  else
    echo "[sync] ⚠️  $c not running"
  fi
done
echo "[sync] Done."
