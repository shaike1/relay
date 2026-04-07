#!/usr/bin/env bash
# sync-schedules.sh — Auto-generate daily-compact schedule entries for all Claude sessions
# Adds missing entries, removes stale ones, preserves all non-daily-compact entries.

set -euo pipefail

SESSIONS_FILE="${SESSIONS_FILE:-/root/relay/sessions.json}"
SCHEDULES_FILE="${SCHEDULES_FILE:-/root/relay/schedules.json}"

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed." >&2
  exit 1
fi

if [[ ! -f "$SESSIONS_FILE" ]]; then
  echo "ERROR: sessions file not found: $SESSIONS_FILE" >&2
  exit 1
fi

if [[ ! -f "$SCHEDULES_FILE" ]]; then
  echo "ERROR: schedules file not found: $SCHEDULES_FILE" >&2
  exit 1
fi

echo "Reading sessions from: $SESSIONS_FILE"
echo "Reading schedules from: $SCHEDULES_FILE"

# Build updated schedules.json using jq
# Logic:
#   1. Keep all non-daily-compact entries as-is
#   2. For each claude session, keep existing daily-compact entry (preserving customizations)
#      or create a new one with defaults
#   3. Drop daily-compact entries for sessions that no longer exist

UPDATED=$(jq -n \
  --slurpfile sessions "$SESSIONS_FILE" \
  --slurpfile schedules "$SCHEDULES_FILE" \
  '
  # Sessions that are claude type (no type field, or type == "claude")
  ($sessions[0] | map(select(.type == null or .type == "claude"))) as $claude_sessions |

  # Map of session name -> thread_id
  ($claude_sessions | map({key: .session, value: .thread_id}) | from_entries) as $session_map |

  # Set of claude session names
  ($claude_sessions | map(.session) | unique) as $session_names |

  # Existing non-daily-compact entries (keep as-is)
  ($schedules[0] | map(select(.id | test("^daily-compact-") | not))) as $other_entries |

  # Existing daily-compact entries indexed by session name
  ($schedules[0] | map(select(.id | test("^daily-compact-")))
    | map({key: (.id | ltrimstr("daily-compact-")), value: .})
    | from_entries) as $existing_compact |

  # Build new daily-compact entries for all claude sessions
  ($claude_sessions | map(
    . as $s |
    ($s.session) as $name |
    ($existing_compact[$name]) as $existing |
    if $existing != null then
      $existing
    else
      {
        "id": ("daily-compact-" + $name),
        "cron": "0 6 * * *",
        "thread_id": $s.thread_id,
        "message": "Please compact the context now.",
        "via": "scheduler",
        "enabled": true
      }
    end
  )) as $compact_entries |

  # Combine: other entries + compact entries (sorted by id for readability)
  ($other_entries + $compact_entries)
  | sort_by(.id // "")
')

# Count changes
OLD_COUNT=$(jq '[.[] | select(.id | test("^daily-compact-"))] | length' "$SCHEDULES_FILE")
NEW_COUNT=$(echo "$UPDATED" | jq '[.[] | select(.id | test("^daily-compact-"))] | length')

echo "Previous daily-compact entries: $OLD_COUNT"
echo "New daily-compact entries:      $NEW_COUNT"

# Write updated file
echo "$UPDATED" > "$SCHEDULES_FILE"
echo "Wrote updated schedules to: $SCHEDULES_FILE"

# Show summary
echo ""
echo "Active daily-compact sessions:"
echo "$UPDATED" | jq -r '.[] | select(.id | test("^daily-compact-")) | "  \(.id) (thread \(.thread_id)) enabled=\(.enabled)"'
