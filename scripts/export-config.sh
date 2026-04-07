#!/usr/bin/env bash
# export-config.sh — Export relay config files to a ZIP archive
# Creates /tmp/relay-config-export.zip with sessions.json, schedules.json,
# docker-compose.yml, skills/, and templates/
set -euo pipefail

RELAY_DIR="/root/relay"
OUTPUT_ZIP="/tmp/relay-config-export.zip"

echo "[export-config] Creating config export ZIP..."

# Remove existing zip
rm -f "$OUTPUT_ZIP"

# Collect files and directories
FILES=()

for f in \
  "${RELAY_DIR}/sessions.json" \
  "${RELAY_DIR}/schedules.json" \
  "${RELAY_DIR}/docker-compose.yml" \
  "${RELAY_DIR}/docker-compose.sessions.yml"
do
  if [[ -f "$f" ]]; then
    FILES+=("$f")
    echo "[export-config] Including: $f"
  fi
done

# Include skills/ and templates/ directories
for dir in "${RELAY_DIR}/skills" "${RELAY_DIR}/templates"; do
  if [[ -d "$dir" ]]; then
    FILES+=("$dir")
    echo "[export-config] Including dir: $dir"
  fi
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "[export-config] No files found!"
  exit 1
fi

# Create ZIP (use zip if available, else tar)
if command -v zip &>/dev/null; then
  zip -r "$OUTPUT_ZIP" "${FILES[@]}" 2>/dev/null
else
  # Fallback: create a tar.gz instead
  OUTPUT_ZIP="/tmp/relay-config-export.tar.gz"
  tar -czf "$OUTPUT_ZIP" "${FILES[@]}" 2>/dev/null
fi

SIZE=$(du -sh "$OUTPUT_ZIP" | cut -f1)
echo "[export-config] Created: $OUTPUT_ZIP ($SIZE)"
