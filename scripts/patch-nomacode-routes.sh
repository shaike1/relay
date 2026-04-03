#!/bin/bash
# patch-nomacode-routes.sh — Add metrics, logs, and config endpoints to nomacode
# Run from host: bash /root/relay/scripts/patch-nomacode-routes.sh
# Then restart nomacode
set -euo pipefail

INDEX="/root/nomacode/server/index.js"

# Check if already patched
if grep -q 'relay-metrics' "$INDEX" 2>/dev/null; then
    echo "Already patched (relay-metrics found). Skipping."
    exit 0
fi

# Find the line after config.init(); and inject routes
sed -i '/^config\.init();$/a\
\
// === Relay routes (no auth required) ===\
const { execSync } = require("child_process");\
const fs = require("fs");\
\
app.get("/api/relay-metrics", (req, res) => {\
  try {\
    const out = execSync("bash /root/relay/scripts/metrics.sh", {timeout:15000}).toString();\
    res.type("json").send(out);\
  } catch(e) { res.json([]); }\
});\
\
app.get("/metrics", (req, res) => {\
  try {\
    res.type("html").send(fs.readFileSync("/root/relay/metrics.html","utf8"));\
  } catch(e) { res.status(500).send("Not found"); }\
});\
\
app.get("/api/session-logs", (req, res) => {\
  const session = req.query.session;\
  const lines = req.query.lines || 30;\
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {\
    return res.status(400).json({error: "Invalid session name"});\
  }\
  try {\
    const out = execSync(`bash /root/relay/scripts/session-logs.sh ${session} ${lines}`, {timeout:10000}).toString();\
    res.type("json").json({session, lines: out.split("\\n")});\
  } catch(e) { res.status(500).json({error: "Failed to get logs"}); }\
});\
\
app.get("/api/sessions-config", (req, res) => {\
  try {\
    res.type("json").send(fs.readFileSync("/root/relay/sessions.json","utf8"));\
  } catch(e) { res.status(500).json({error: "Failed to read config"}); }\
});\
\
app.post("/api/sessions-config", express.json(), (req, res) => {\
  try {\
    const data = JSON.stringify(req.body, null, 2);\
    fs.writeFileSync("/root/relay/sessions.json", data);\
    res.json({ok: true});\
  } catch(e) { res.status(500).json({error: "Failed to save config"}); }\
});\
\
app.get("/config", (req, res) => {\
  try {\
    res.type("html").send(fs.readFileSync("/root/relay/config.html","utf8"));\
  } catch(e) { res.status(500).send("Config page not found"); }\
});\
// === End relay routes ===' "$INDEX"

echo "Patched $INDEX with relay routes."
echo "Restart nomacode to apply."
