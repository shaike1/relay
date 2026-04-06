#!/bin/bash
# apply-template.sh — applies a session template to a workdir.
# Usage: apply-template.sh <template_name> <workdir>
# Templates: /relay/templates/<name>.json
set -euo pipefail

TEMPLATE_NAME="${1:?template name required}"
WORKDIR="${2:?workdir required}"
TEMPLATES_DIR="/relay/templates"
TEMPLATE_FILE="${TEMPLATES_DIR}/${TEMPLATE_NAME}.json"

if [ ! -f "$TEMPLATE_FILE" ]; then
  echo "Template '$TEMPLATE_NAME' not found. Available:" >&2
  ls "${TEMPLATES_DIR}"/*.json 2>/dev/null | xargs -I{} basename {} .json | sed 's/^/  /' >&2
  exit 1
fi

python3 - "$TEMPLATE_FILE" "$WORKDIR" <<'PY'
import json, os, sys

template_file, workdir = sys.argv[1], sys.argv[2]
t = json.load(open(template_file))

claude_dir = os.path.join(workdir, '.claude')
os.makedirs(claude_dir, exist_ok=True)

# Write CLAUDE.md
claude_md_path = os.path.join(claude_dir, 'CLAUDE.md')
if t.get('claude_md'):
    with open(claude_md_path, 'w') as f:
        f.write(t['claude_md'])
    print(f"Wrote {claude_md_path}")

# Write skills list for load-skills.sh
if t.get('skills'):
    skills_path = os.path.join(claude_dir, 'skills.txt')
    with open(skills_path, 'w') as f:
        f.write('\n'.join(t['skills']) + '\n')
    print(f"Wrote {skills_path} ({', '.join(t['skills'])})")

print(f"Applied template '{t['name']}' to {workdir}")
PY
