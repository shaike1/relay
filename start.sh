#!/bin/bash
# start.sh — one-command launcher for the full Claude Telegram Relay stack
#
# Starts: relay bot + all local Claude session containers
#
# Usage:
#   ./start.sh            # start everything
#   ./start.sh --build    # rebuild images then start
#   ./start.sh --regen    # regenerate docker-compose.sessions.yml first
#   ./start.sh stop       # stop all containers
#   ./start.sh logs       # follow logs for all services
#   ./start.sh logs relay-session-main   # logs for a specific session

set -euo pipefail

RELAY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_BASE="$RELAY_DIR/docker-compose.yml"
COMPOSE_SESSIONS="$RELAY_DIR/docker-compose.sessions.yml"
SESSIONS_FILE="$RELAY_DIR/sessions.json"

CMD="${1:-up}"
shift 2>/dev/null || true

case "$CMD" in
  stop)
    echo "Stopping all relay containers..."
    docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_SESSIONS" down "$@"
    exit 0
    ;;
  logs)
    docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_SESSIONS" logs -f "$@"
    exit 0
    ;;
  ps)
    docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_SESSIONS" ps "$@"
    exit 0
    ;;
  --regen)
    echo "Regenerating docker-compose.sessions.yml from sessions.json..."
    python3 "$RELAY_DIR/scripts/generate-compose.py"
    CMD="up"
    ;;
esac

# Regenerate sessions compose if sessions.json is newer
if [ "$SESSIONS_FILE" -nt "$COMPOSE_SESSIONS" ] 2>/dev/null; then
  echo "sessions.json changed — regenerating docker-compose.sessions.yml..."
  python3 "$RELAY_DIR/scripts/generate-compose.py"
fi

# Ensure the shared queue volume exists
if ! docker volume inspect relay-queue >/dev/null 2>&1; then
  echo "Creating shared relay-queue volume..."
  docker volume create relay-queue
fi

BUILD_FLAG=""
if [ "${1:-}" = "--build" ]; then
  BUILD_FLAG="--build"
  shift
fi

echo "Starting relay stack (bot + sessions)..."
docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_SESSIONS" up -d $BUILD_FLAG "$@"

echo ""
echo "Stack is up. Useful commands:"
echo "  ./start.sh logs               — follow all logs"
echo "  ./start.sh logs relay          — bot logs"
echo "  ./start.sh logs relay-session-main  — session logs"
echo "  ./start.sh ps                  — container status"
echo "  ./start.sh stop                — stop everything"
