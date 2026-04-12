#!/bin/bash
# deploy-scripts.sh — Copy updated relay scripts into all running session containers
# and restart their watchdog processes so the new code takes effect immediately.
#
# Usage:
#   ./deploy-scripts.sh                  # deploy all scripts, restart watchdogs
#   ./deploy-scripts.sh --no-restart     # copy files only, skip watchdog restart
#   ./deploy-scripts.sh token-logger.sh  # deploy a single named script
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTART_WATCHDOG=true
TARGET_SCRIPT=""

for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART_WATCHDOG=false ;;
    --*)          echo "Unknown option: $arg"; exit 1 ;;
    *)            TARGET_SCRIPT="$arg" ;;
  esac
done

# Scripts to deploy (relative to SCRIPTS_DIR)
if [ -n "$TARGET_SCRIPT" ]; then
  DEPLOY_SCRIPTS=("$TARGET_SCRIPT")
else
  DEPLOY_SCRIPTS=(
    message-watchdog.sh
    token-logger.sh
    pre-compact-extract.sh
    pre-compact.sh
    pre-tool-hook.sh
    post-tool-hook.sh
    tg-send.sh
  )
fi

# Collect local + remote containers
LOCAL_CONTAINERS=()
while IFS= read -r name; do
  LOCAL_CONTAINERS+=("$name")
done < <(docker ps --format '{{.Names}}' | grep relay-session)

# Remote hosts: "host:container" pairs
REMOTE_SESSIONS=(
  "100.64.0.12:relay-session-edushare"
)

ok=0; fail=0; skipped=0

deploy_to_container() {
  local container="$1"
  local host="${2:-}"  # empty = local

  local deployed=0
  for script in "${DEPLOY_SCRIPTS[@]}"; do
    src="${SCRIPTS_DIR}/${script}"
    [ -f "$src" ] || { echo "  ⚠ skipped $script (not found)"; skipped=$((skipped+1)); continue; }
    dest="/relay/scripts/${script}"

    if [ -z "$host" ]; then
      docker cp "$src" "${container}:${dest}" 2>/dev/null && deployed=$((deployed+1))
    else
      docker cp "$src" "${container}:${dest}" 2>/dev/null && deployed=$((deployed+1))
      # For SSH remotes we use docker cp via SSH pipe
    fi
  done

  # Restart watchdog
  if $RESTART_WATCHDOG && [ "$deployed" -gt 0 ]; then
    local pid
    if [ -z "$host" ]; then
      pid=$(docker exec "$container" pgrep -f message-watchdog 2>/dev/null | head -1 || true)
      [ -n "$pid" ] && docker exec "$container" kill "$pid" 2>/dev/null && echo "  ↺ watchdog restarted (was PID $pid)" || true
    else
      pid=$(ssh "$host" "docker exec $container pgrep -f message-watchdog 2>/dev/null | head -1" 2>/dev/null || true)
      [ -n "$pid" ] && ssh "$host" "docker exec $container kill $pid" 2>/dev/null && echo "  ↺ watchdog restarted (was PID $pid)" || true
    fi
  fi

  return 0
}

echo "🚀 Deploying ${#DEPLOY_SCRIPTS[@]} script(s) to ${#LOCAL_CONTAINERS[@]} local + ${#REMOTE_SESSIONS[@]} remote containers"
echo ""

# Local containers
for container in "${LOCAL_CONTAINERS[@]}"; do
  session="${container#relay-session-}"
  echo "▸ $session"
  if deploy_to_container "$container" ""; then
    echo "  ✓ done"
    ok=$((ok+1))
  else
    echo "  ✗ failed"
    fail=$((fail+1))
  fi
done

# Remote containers
for remote in "${REMOTE_SESSIONS[@]}"; do
  host="${remote%%:*}"
  container="${remote##*:}"
  session="${container#relay-session-}"
  echo "▸ $session (${host})"

  # Copy via SSH pipe
  deployed=0
  for script in "${DEPLOY_SCRIPTS[@]}"; do
    src="${SCRIPTS_DIR}/${script}"
    [ -f "$src" ] || continue
    dest="/relay/scripts/${script}"
    ssh "$host" "cat > /tmp/_deploy_${script} && docker cp /tmp/_deploy_${script} ${container}:${dest} && rm /tmp/_deploy_${script}" \
      < "$src" 2>/dev/null && deployed=$((deployed+1)) || true
  done

  if $RESTART_WATCHDOG && [ "$deployed" -gt 0 ]; then
    pid=$(ssh "$host" "docker exec $container pgrep -f message-watchdog 2>/dev/null | head -1" 2>/dev/null || true)
    [ -n "$pid" ] && ssh "$host" "docker exec $container kill $pid" 2>/dev/null \
      && echo "  ↺ watchdog restarted (was PID $pid)" || true
  fi

  echo "  ✓ done ($deployed scripts)"
  ok=$((ok+1))
done

echo ""
echo "✅ Done: $ok OK, $fail failed, $skipped skipped"
