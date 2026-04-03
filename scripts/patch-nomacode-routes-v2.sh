#!/bin/bash
# patch-nomacode-routes-v2.sh — Add config, logs, sessions endpoints to nomacode
# Injects AFTER the existing working /api/relay-metrics route
# Run from host: bash /root/relay/scripts/patch-nomacode-routes-v2.sh
set -euo pipefail

INDEX="/root/nomacode/server/index.js"

# Check if already patched with v2
if grep -q '/api/sessions-config' "$INDEX" 2>/dev/null; then
    echo "Already patched (sessions-config found). Skipping."
    exit 0
fi

# Find the existing working relay-metrics route and inject after its closing block
# We look for the first occurrence of /api/relay-metrics and inject after its try/catch block
sed -i '/app\.get("\/api\/relay-metrics"/,/});/{
  /});/a\
\
app.get("/api/session-logs", (req, res) => {\
  const session = req.query.session;\
  const lines = req.query.lines || 30;\
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {\
    return res.status(400).json({error: "Invalid session name"});\
  }\
  try {\
    const out = require("child_process").execSync(`bash /root/relay/scripts/session-logs.sh ${session} ${lines}`, {timeout:10000}).toString();\
    res.type("json").json({session, lines: out.split("\\n")});\
  } catch(e) { res.status(500).json({error: "Failed to get logs"}); }\
});\
\
app.get("/api/sessions-config", (req, res) => {\
  try {\
    res.type("json").send(require("fs").readFileSync("/root/relay/sessions.json","utf8"));\
  } catch(e) { res.status(500).json({error: "Failed to read config"}); }\
});\
\
app.post("/api/sessions-config", express.json(), (req, res) => {\
  try {\
    const data = JSON.stringify(req.body, null, 2);\
    require("fs").writeFileSync("/root/relay/sessions.json", data);\
    res.json({ok: true});\
  } catch(e) { res.status(500).json({error: "Failed to save config"}); }\
});\
\
app.get("/config", (req, res) => {\
  try {\
    res.type("html").send(require("fs").readFileSync("/root/relay/config.html","utf8"));\
  } catch(e) { res.status(500).send("Config page not found"); }\
});
}' "$INDEX"

echo "Patched $INDEX with v2 routes (after relay-metrics)."
echo "Restart nomacode to apply."
