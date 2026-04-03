#!/bin/bash
# patch-nomacode-restart.sh — Add session restart endpoint to nomacode
# Run from host: bash /root/relay/scripts/patch-nomacode-restart.sh
set -euo pipefail

INDEX="/root/nomacode/server/index.js"

# Check if already patched
if grep -q 'session-restart' "$INDEX" 2>/dev/null; then
    echo "Already patched (session-restart found). Skipping."
    exit 0
fi

# Inject after /api/sessions-config POST route
sed -i '/app\.post("\/api\/sessions-config"/,/});/{
  /});/a\
\
app.post("/api/session-restart", express.json(), (req, res) => {\
  const session = req.body.session;\
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {\
    return res.status(400).json({error: "Invalid session name"});\
  }\
  try {\
    const out = require("child_process").execSync(\
      `bash /root/relay/scripts/session-restart.sh ${session}`,\
      {timeout: 30000}\
    ).toString();\
    res.type("json").send(out);\
  } catch(e) { res.status(500).json({error: "Restart failed: " + e.message}); }\
});
}' "$INDEX"

echo "Patched $INDEX with session-restart endpoint."
echo "Restart nomacode to apply."
