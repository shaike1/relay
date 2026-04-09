#!/bin/bash
# git-auto-commit.sh — PostToolUse/Stop hook: auto-commit modified files after each Claude turn.
# Only runs if AUTO_GIT_COMMIT=1 is set in the session environment.
# Reads the tool call from stdin (Claude Code hook JSON format).
#
# Behavior:
#   - On Edit/Write tool calls: records which files were touched (debounced)
#   - On Stop hook (turn end): if any tracked files are modified, stages + commits them
#
# Called by settings.json PostToolUse and Stop hooks.

set -euo pipefail

# Only run if opt-in
[ "${AUTO_GIT_COMMIT:-0}" = "1" ] || exit 0

# Load env if available
[ -f /root/relay/.env ] && source <(grep -E '^(AUTO_GIT_COMMIT|GIT_COMMIT_WORKDIR)=' /root/relay/.env 2>/dev/null) 2>/dev/null || true

THREAD_ID="${TELEGRAM_THREAD_ID:-0}"
COMMIT_STATE="/tmp/relay-git-pending-${THREAD_ID}"
WORKDIR="${GIT_COMMIT_WORKDIR:-}"

# Read hook input (may be empty on Stop hook)
INPUT="$(cat 2>/dev/null || echo '{}')"
HOOK_EVENT="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('hook_event_name',''))" 2>/dev/null || echo '')"
TOOL_NAME="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo '')"

if [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; then
  FILE="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo '')"
  if [ -n "$FILE" ] && [ -f "$FILE" ]; then
    # Track this file for commit
    echo "$FILE" >> "$COMMIT_STATE" 2>/dev/null || true
  fi
  exit 0
fi

# On Stop hook or explicit commit trigger: commit pending changes
if [ "$HOOK_EVENT" = "Stop" ] || [ "$1" = "--commit" ]; then
  [ -f "$COMMIT_STATE" ] || exit 0

  # Collect unique files that were modified
  mapfile -t PENDING_FILES < <(sort -u "$COMMIT_STATE" 2>/dev/null || true)
  rm -f "$COMMIT_STATE"

  [ "${#PENDING_FILES[@]}" -gt 0 ] || exit 0

  # Find the git repo for these files
  for FILE in "${PENDING_FILES[@]}"; do
    [ -f "$FILE" ] || continue
    DIR="$(dirname "$FILE")"
    REPO="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || echo '')"
    if [ -n "$REPO" ]; then
      WORKDIR="$REPO"
      break
    fi
  done

  [ -n "$WORKDIR" ] || exit 0
  [ -d "$WORKDIR/.git" ] || exit 0

  # Check for actual changes
  cd "$WORKDIR"
  CHANGED="$(git status --porcelain 2>/dev/null | head -20 || echo '')"
  [ -n "$CHANGED" ] || exit 0

  # Stage only the tracked files (not untracked/other)
  for FILE in "${PENDING_FILES[@]}"; do
    [ -f "$FILE" ] || continue
    git add -- "$FILE" 2>/dev/null || true
  done

  STAGED="$(git diff --cached --name-only 2>/dev/null || echo '')"
  [ -n "$STAGED" ] || exit 0

  FILE_COUNT=$(echo "$STAGED" | wc -l | tr -d ' ')
  FIRST_FILE=$(echo "$STAGED" | head -1)
  SESSION="${SESSION_NAME:-claude}"
  MSG="auto: ${SESSION} edited ${FILE_COUNT} file(s) — ${FIRST_FILE}"

  git commit -m "$MSG" --no-gpg-sign 2>/dev/null || true
  echo "[git-auto-commit] committed: $MSG" >&2
fi

exit 0
