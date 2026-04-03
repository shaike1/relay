const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 9100;

const SESSIONS_FILE = process.env.SESSIONS_FILE || '/relay/sessions.json';
const METRICS_HTML = path.join(__dirname, '..', 'metrics.html');
const CONFIG_HTML = path.join(__dirname, '..', 'config.html');

app.use(express.json());

// --- Static pages ---

app.get('/metrics', (req, res) => {
  try {
    res.type('html').send(fs.readFileSync(METRICS_HTML, 'utf8'));
  } catch (e) { res.status(500).send('Dashboard not found'); }
});

app.get('/config', (req, res) => {
  try {
    res.type('html').send(fs.readFileSync(CONFIG_HTML, 'utf8'));
  } catch (e) { res.status(500).send('Config page not found'); }
});

// --- API endpoints ---

app.get('/api/relay-metrics', (req, res) => {
  try {
    const out = execSync('bash /relay/scripts/metrics.sh', { timeout: 15000 }).toString();
    res.type('json').send(out);
  } catch (e) { res.json([]); }
});

app.get('/api/session-logs', (req, res) => {
  const session = req.query.session;
  const lines = req.query.lines || 30;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  try {
    const out = execSync(`bash /relay/scripts/session-logs.sh ${session} ${lines}`, { timeout: 10000 }).toString();
    res.json({ session, lines: out.split('\n') });
  } catch (e) { res.status(500).json({ error: 'Failed to get logs' }); }
});

app.get('/api/sessions-config', (req, res) => {
  try {
    res.type('json').send(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) { res.status(500).json({ error: 'Failed to read config' }); }
});

app.post('/api/sessions-config', (req, res) => {
  try {
    const data = JSON.stringify(req.body, null, 2);
    fs.writeFileSync(SESSIONS_FILE, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save config' }); }
});

app.post('/api/session-restart', (req, res) => {
  const session = req.body.session;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  try {
    const out = execSync(`bash /relay/scripts/session-restart.sh ${session}`, { timeout: 30000 }).toString();
    res.type('json').send(out);
  } catch (e) { res.status(500).json({ error: 'Restart failed: ' + e.message }); }
});

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Relay API server listening on port ${PORT}`);
});
