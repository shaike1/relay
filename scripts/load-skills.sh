#!/bin/bash
# load-skills.sh — injects skill-specific context into Claude's CLAUDE.md.
# Called at session startup from claude-session-loop.sh.
# Reads the session's skills array from sessions.json and appends
# matching skill files from /relay/skills/ to .claude/CLAUDE.md in WORKDIR.
#
# Usage: load-skills.sh <session_name> <workdir>
# Skill files: /relay/skills/<skill-name>.md
set -euo pipefail

SESSION="${1:?session name required}"
WORKDIR="${2:?workdir required}"
SESSIONS_FILE="/relay/sessions.json"
SKILLS_DIR="/relay/skills"
TARGET_CLAUDE_MD="${WORKDIR}/.claude/CLAUDE.md"

[ -f "$SESSIONS_FILE" ] || exit 0

# Get skills for this session
SKILLS=$(python3 -c "
import json, sys
try:
    sessions = json.load(open('$SESSIONS_FILE'))
    for s in sessions:
        if s.get('session') == '$SESSION':
            print('\n'.join(s.get('skills', [])))
            sys.exit(0)
except: pass
" 2>/dev/null)

[ -z "$SKILLS" ] && exit 0
[ -d "$SKILLS_DIR" ] || exit 0

mkdir -p "$(dirname "$TARGET_CLAUDE_MD")"

# Marker to avoid duplicate injection on restart
MARKER="# [relay-skills-loaded]"
if [ -f "$TARGET_CLAUDE_MD" ] && grep -q "$MARKER" "$TARGET_CLAUDE_MD" 2>/dev/null; then
    exit 0
fi

INJECTED=0
while IFS= read -r skill; do
    skill_file="${SKILLS_DIR}/${skill}.md"
    if [ -f "$skill_file" ]; then
        echo "" >> "$TARGET_CLAUDE_MD"
        cat "$skill_file" >> "$TARGET_CLAUDE_MD"
        echo "[load-skills] Injected skill '${skill}' into ${TARGET_CLAUDE_MD}"
        INJECTED=1
    fi
done <<< "$SKILLS"

[ "$INJECTED" = "1" ] && echo "$MARKER" >> "$TARGET_CLAUDE_MD"
