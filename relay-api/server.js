const express = require('express');
const { execSync } = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 9100;
const NOMACODE_URL = process.env.NOMACODE_URL || 'http://relay-nomacode:3000';

const SESSIONS_FILE = process.env.SESSIONS_FILE || '/relay/sessions.json';
const METRICS_SCRIPT = 'bash /relay/scripts/metrics.sh';
const TEMPLATES_FILE = process.env.TEMPLATES_FILE || '/relay/templates.json';
const METRICS_HTML = process.env.METRICS_HTML || '/relay/metrics.html';
const CONFIG_HTML = process.env.CONFIG_HTML || '/relay/config.html';

// --- Auth ---
const AUTH_USER = process.env.AUTH_USER || 'relay';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_COOKIE_NAME = 'relay_auth';
const NOMACODE_COOKIE_NAME = 'relay_session';
const AUTH_TOKEN = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');

function setAuthCookies(res) {
  const cookieOpts = { maxAge: 86400000, path: '/', sameSite: 'Lax' };
  res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, cookieOpts);
  res.cookie(NOMACODE_COOKIE_NAME, AUTH_TOKEN, cookieOpts);
}

function checkAuth(req) {
  // URL token auth (?token=xxx) — sets cookie and redirects
  const urlToken = req.query.token;
  if (urlToken === AUTH_TOKEN) return true;
  // Cookie auth
  const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(AUTH_COOKIE_NAME + '='));
  if (cookie) {
    const val = decodeURIComponent(cookie.substring(cookie.indexOf('=') + 1));
    if (val === AUTH_TOKEN) return true;
  }
  // Basic auth
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [user, pass] = decoded.split(':');
    if (user === AUTH_USER && pass === AUTH_PASS) return true;
  }
  return false;
}

function authMiddleware(req, res, next) {
  if (!AUTH_PASS) return next(); // No auth if no password set
  // Allow health check without auth
  if (req.path === '/health') return next();
  // Allow login page
  if (req.path === '/login') return next();
  if (checkAuth(req)) {
    // If auth via URL token, set cookie and redirect to clean URL
    if (req.query.token) {
      setAuthCookies(res);
      const cleanUrl = req.originalUrl.replace(/[?&]token=[^&]+/, '').replace(/[?&]$/, '').replace(/&/, '?');
      return res.redirect(cleanUrl || '/');
    }
    return next();
  }
  // Redirect to login for HTML pages, 401 for API
  if (req.path.startsWith('/api/')) {
    res.set('WWW-Authenticate', 'Basic realm="Relay API"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

app.use(express.json());

// Login page
app.get('/login', (req, res) => {
  if (!AUTH_PASS) return res.redirect('/metrics');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:#0d1117;display:flex;align-items:center;justify-content:center;font-family:'SF Mono','Fira Code',monospace;color:#c9d1d9}
.wrap{width:100%;max-width:340px;padding:20px}
h1{font-size:16px;font-weight:400;color:#f0f6fc;margin-bottom:20px}
.field{margin-bottom:14px}
.field label{display:block;font-size:11px;color:#8b949e;margin-bottom:4px;text-transform:uppercase}
.field input{width:100%;background:#161b22;border:1px solid #21262d;border-radius:4px;padding:10px;color:#c9d1d9;font-family:inherit;font-size:14px}
.field input:focus{outline:none;border-color:#58a6ff}
.btn{width:100%;background:#238636;border:1px solid #2ea043;border-radius:6px;padding:10px;color:#fff;font-family:inherit;font-size:14px;cursor:pointer;margin-top:8px}
.btn:hover{background:#2ea043}
.error{color:#f85149;font-size:12px;margin-top:12px;display:none}
</style></head><body><div class="wrap">
<h1>Relay Management</h1>
<form onsubmit="return doLogin()">
<div class="field"><label>Username</label><input id="user" value="relay"></div>
<div class="field"><label>Password</label><input id="pass" type="password" autofocus></div>
<button class="btn" type="submit">Login</button>
<div class="error" id="err">Invalid credentials</div>
</form></div>
<div style="margin-top:12px;font-size:12px;color:#8b949e;text-align:center">
<a href="/clear-cache" style="color:#58a6ff;text-decoration:none">Clear browser cache</a>
</div>
<script>
function doLogin(){
  const u=document.getElementById('user').value;
  const p=document.getElementById('pass').value;
  const token=btoa(u+':'+p);
  document.cookie='relay_auth='+token+';path=/;max-age=86400;SameSite=Lax';
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:u,pass:p})}).then(r=>r.json()).then(d=>{
    if(d.ok){location.href='/';}
    else{document.getElementById('err').style.display='block';}
  }).catch(()=>{
    location.href='/?token='+token;
  });return false;
}
</script></body></html>`);
});

// Public cache reset page for recovering stale Relay browser state.
app.get('/clear-cache', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay Cache Reset</title></head><body><script>
(async()=>{
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  }
  document.body.textContent = 'Relay cache cleared. Redirecting...';
  setTimeout(() => location.href = '/login?cleared=1', 800);
})().catch(() => {
  location.href = '/login?cleared=1';
});
</script></body></html>`);
});

// Always serve a self-destructing service worker script on the public domain.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`self.addEventListener('install',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(key=>caches.delete(key)))));self.skipWaiting();});self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(key=>caches.delete(key)))).then(()=>self.registration.unregister()));self.clients.claim();});`);
});

// Login API (no auth required)
app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === AUTH_USER && pass === AUTH_PASS) {
    setAuthCookies(res);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Invalid credentials' });
});

// --- Telegram Webhook (no auth — secured by secret token in URL) ---
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || require('crypto').randomBytes(16).toString('hex');
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.GROUP_CHAT_ID || '';
const QUEUE_DIR = '/tmp';
const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL || 'http://relay:18793/tg';

// Webhook endpoints — receive Telegram updates from both bots,
// write to per-topic queues, and forward to bot.py for processing.
// Main bot webhook
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ok: true });
  webhookQueueWrite(req.body);
  forwardToBot(req.body);
});
// Codex bot webhook (same handler, different URL for separate bot token)
const CODEX_WEBHOOK_SECRET = process.env.CODEX_WEBHOOK_SECRET || `codex-${WEBHOOK_SECRET}`;
app.post(`/webhook/${CODEX_WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ok: true });
  webhookQueueWrite(req.body);
  // Don't forward codex updates to bot.py — they're handled by session-driver
});

// Reaction emoji → natural language command
const REACTION_COMMANDS = {
  '👍': 'Looks good! Continue with the next steps.',
  '🔁': 'Please retry / redo your last response.',
  '❌': 'Cancel / stop what you were doing.',
  '✅': 'Confirmed — go ahead.',
  '🚀': 'Deploy / run it now.',
  '🛑': 'Stop immediately.',
  '💡': 'Good idea — implement it.',
  '🤔': 'I\'m not sure about this. Please explain your reasoning.',
};

function webhookQueueWrite(update) {
  // Handle message reactions (👍, 🔁, ❌, etc.)
  if (update && update.message_reaction) {
    const rxn = update.message_reaction;
    const threadId = rxn.chat && rxn.message_thread_id;
    if (!threadId || String(rxn.chat.id) !== String(TG_CHAT_ID)) return;
    const newReactions = rxn.new_reaction || [];
    for (const r of newReactions) {
      const emoji = r.emoji || '';
      const cmd = REACTION_COMMANDS[emoji];
      if (!cmd) continue;
      const now = Math.floor(Date.now() / 1000);
      const entry = {
        message_id: -(now % 2147483647),
        user: rxn.user ? (rxn.user.first_name || rxn.user.username || 'user') : 'user',
        user_id: rxn.user ? rxn.user.id : 0,
        text: `[Reaction ${emoji}]: ${cmd}`,
        ts: now,
        via: 'reaction',
        force: true,
      };
      try {
        fs.appendFileSync(path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`), JSON.stringify(entry) + '\n');
        console.log(`[reaction] ${threadId}: ${emoji} → ${cmd}`);
      } catch (e) { console.error('[reaction] error:', e.message); }
    }
    return;
  }

  // Handle inline button callbacks (callback_query)
  if (update && update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';

    // History pagination callback: hist:THREAD_ID:PAGE
    const histMatch = data.match(/^hist:(\d+):(\d+)$/);
    if (histMatch) {
      const threadId = histMatch[1];
      const page = parseInt(histMatch[2]);
      const msgId = cb.message && cb.message.message_id;
      // Answer callback to remove spinner
      if (cb.id) {
        fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery?callback_query_id=${cb.id}`)
          .catch(() => {});
      }
      handleHistoryCommand(threadId, null, page, msgId).catch(e => console.error('[history] error:', e.message));
      return;
    }

    // Format: btn:THREAD_ID:label
    const match = data.match(/^btn:(\d+):(.+)$/);
    if (!match) return;
    const threadId = match[1];
    const label = match[2];
    const queueFile = path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
    const now = Math.floor(Date.now() / 1000);
    const entry = {
      message_id: -(now % 2147483647),
      user: (cb.from.first_name || cb.from.username || 'unknown'),
      user_id: cb.from.id,
      text: label,
      ts: now,
      via: 'callback',
      force: true,  // required: bypasses message_id <= lastId check in fetch_messages
    };
    try {
      fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
      console.log(`[webhook] ${threadId}: ${cb.from.first_name} clicked: ${label} (cb.id=${cb.id})`);
      // Answer the callback and visually update the button
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken && cb.id) {
        // 1. Answer callback to remove spinner
        fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery?callback_query_id=${cb.id}&text=${encodeURIComponent('✓ ' + label)}`)
          .then(r => r.json())
          .then(d => console.log(`[webhook] answerCallback: ${JSON.stringify(d)}`))
          .catch(e => console.error(`[webhook] answerCallback error: ${e.message}`));
        // 2. Update the message to show which button was clicked
        if (cb.message) {
          // Build new markup with clicked button marked
          const chatId = cb.message.chat.id;
          const msgId = cb.message.message_id;
          // Remove all buttons and append clicked label to the message text
          fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: msgId,
              reply_markup: { inline_keyboard: [[{ text: '✓ ' + label, callback_data: 'noop:done' }]] }
            })
          })
            .then(r => r.json())
            .then(d => console.log(`[webhook] editMarkup: ${JSON.stringify(d).substring(0, 100)}`))
            .catch(e => console.error(`[webhook] editMarkup error: ${e.message}`));
        }
      }
    } catch (err) {
      console.error(`[webhook] Callback queue write error:`, err.message);
    }
    return;
  }

  const msg = update && update.message;
  if (!msg) return;
  if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
  if (msg.from && msg.from.is_bot) return;
  const threadId = msg.message_thread_id;
  if (!threadId) return;

  // Auto-handle /status command without waking Claude (saves tokens)
  if (msg.text && /^\/status(@\S+)?$/i.test(msg.text.trim())) {
    handleStatusCommand(threadId, msg.message_id).catch(e => console.error('[status] error:', e.message));
    return;
  }

  // /template — list or apply a session template
  const templateCmd = msg.text && msg.text.trim().match(/^\/template(@\S+)?(\s+(\S+))?$/i);
  if (templateCmd) {
    handleTemplateCommand(threadId, msg.message_id, templateCmd[3] || null).catch(e => console.error('[template] error:', e.message));
    return;
  }

  // /stats — token usage summary
  if (msg.text && /^\/stats(@\S+)?$/i.test(msg.text.trim())) {
    handleStatsCommand(threadId, msg.message_id).catch(e => console.error('[stats] error:', e.message));
    return;
  }

  // Auto-handle /history [page] command
  const histCmd = msg.text && msg.text.trim().match(/^\/history(@\S+)?(\s+(\d+))?$/i);
  if (histCmd) {
    const page = parseInt(histCmd[3] || '1');
    handleHistoryCommand(threadId, msg.message_id, page, null).catch(e => console.error('[history] error:', e.message));
    return;
  }

  // Voice messages — transcribe via Whisper then queue
  if (msg.voice || msg.audio) {
    handleVoiceMessage(msg, threadId).catch(e => console.error('[voice] error:', e.message));
    return;
  }

  // Photo/image messages — download and queue with file path
  if (msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/'))) {
    handlePhotoMessage(msg, threadId).catch(e => console.error('[photo] error:', e.message));
    return;
  }

  // Drop non-text messages we don't handle
  if (!msg.text) return;

  // Multi-tenant: if session has multi_tenant=true, route per user_id to isolated thread
  const effectiveThreadId = resolveMultiTenantThread(threadId, msg.from.id, msg.from.first_name || msg.from.username || 'user');

  const queueFile = path.join(QUEUE_DIR, `tg-queue-${effectiveThreadId}.jsonl`);
  const entry = {
    message_id: msg.message_id,
    user: (msg.from.first_name || msg.from.username || 'unknown'),
    user_id: msg.from.id,
    text: msg.text,
    ts: Math.floor(Date.now() / 1000),
    via: 'webhook'
  };
  try {
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    console.log(`[webhook] ${effectiveThreadId}: ${msg.from.first_name}: ${msg.text.substring(0, 60)}`);
  } catch (err) {
    console.error(`[webhook] Queue write error:`, err.message);
  }
}

// Multi-tenant routing: maps (thread_id, user_id) → isolated virtual thread_id
// Virtual thread IDs are stored in /tmp/mt-map-{threadId}.json
function resolveMultiTenantThread(threadId, userId, userName) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => String(s.thread_id) === String(threadId));
    if (!session || !session.multi_tenant) return threadId;

    const mapFile = path.join(QUEUE_DIR, `mt-map-${threadId}.json`);
    let map = {};
    try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch (_) {}

    if (!map[userId]) {
      // Assign a new virtual thread_id: base thread_id * 10000 + sequential index
      const existing = Object.values(map);
      const idx = existing.length + 1;
      map[userId] = { virtual_thread: parseInt(threadId) * 10000 + idx, name: userName };
      fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));
      console.log(`[multi-tenant] New user ${userName} (${userId}) → virtual thread ${map[userId].virtual_thread}`);
    }
    return map[userId].virtual_thread;
  } catch (_) {
    return threadId;
  }
}

// Dedup set for /status — prevents double-response when both bots receive the same message
const _handledStatusIds = new Set();

// /status command — auto-respond with container health (no Claude needed)
async function handleStatusCommand(threadId, replyTo) {
  const key = `${threadId}:${replyTo}`;
  if (_handledStatusIds.has(key)) return;
  _handledStatusIds.add(key);
  setTimeout(() => _handledStatusIds.delete(key), 30000); // clean up after 30s
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const lines = ['<b>Session Status</b>'];
    for (const s of sessions) {
      if (s.host) continue; // skip remote sessions for now
      const name = `relay-session-${s.session}`;
      let status = '❓';
      try {
        const out = execSync(`docker inspect --format '{{.State.Status}}' ${name} 2>/dev/null`, { timeout: 3000 }).toString().trim();
        const health = execSync(`docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ${name} 2>/dev/null`, { timeout: 3000 }).toString().trim();
        if (out === 'running' && health === 'healthy') status = '✅';
        else if (out === 'running') status = '🟡';
        else status = '🔴';
      } catch (_) { status = '🔴'; }
      lines.push(`${status} <code>${s.session}</code>`);
    }
    const text = lines.join('\n');
    await tgSendMessage(threadId, text, replyTo, null);
    console.log(`[status] Responded to /status in thread ${threadId}`);
  } catch (e) {
    console.error('[status] Failed:', e.message);
  }
}

// /template command — list templates or apply one to current session
async function handleTemplateCommand(threadId, replyTo, templateName) {
  const TEMPLATES_DIR = '/relay/templates';
  try {
    if (!templateName) {
      // List available templates
      const files = fs.existsSync(TEMPLATES_DIR)
        ? fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'))
        : [];
      if (files.length === 0) {
        await tgSendMessage(threadId, '📋 אין templates זמינים ב-/relay/templates/', replyTo, null);
        return;
      }
      const lines = ['📋 <b>Session Templates</b>', ''];
      for (const f of files) {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'));
          lines.push(`• <code>${t.name}</code> — ${t.description || ''}`);
        } catch (_) {}
      }
      lines.push('', 'שימוש: <code>/template &lt;name&gt;</code>');
      const btns = files.map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8')).name; } catch { return null; }
      }).filter(Boolean).map(n => ({ text: n, callback_data: `btn:${threadId}:/template ${n}` }));
      await tgSendMessage(threadId, lines.join('\n'), replyTo, btns.length ? { inline_keyboard: [btns] } : null);
      return;
    }

    // Apply template — find session workdir
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => String(s.thread_id) === String(threadId));
    if (!session) {
      await tgSendMessage(threadId, `❌ Session לא נמצא ל-thread ${threadId}`, replyTo, null);
      return;
    }
    const { execSync } = require('child_process');
    execSync(`bash /relay/scripts/apply-template.sh ${templateName} ${session.path}`, { timeout: 10000 });
    await tgSendMessage(threadId, `✅ Template <code>${templateName}</code> הוחל על <code>${session.path}</code>\nRestart session לטעינה.`, replyTo, null);
  } catch (e) {
    await tgSendMessage(threadId, `❌ שגיאה: ${e.message.substring(0, 200)}`, replyTo, null);
  }
}

// /stats command — token usage and cost summary from token-stats file
const _handledStatsIds = new Set();

async function handleStatsCommand(threadId, replyTo) {
  const key = `${threadId}:${replyTo}`;
  if (_handledStatsIds.has(key)) return;
  _handledStatsIds.add(key);
  setTimeout(() => _handledStatsIds.delete(key), 30000);

  try {
    const statsFile = path.join(QUEUE_DIR, `token-stats-${threadId}.jsonl`);
    const lines = fs.existsSync(statsFile)
      ? fs.readFileSync(statsFile, 'utf8').split('\n').filter(l => l.trim())
      : [];

    if (lines.length === 0) {
      await tgSendMessage(threadId, '📊 אין נתוני שימוש עדיין (Stop hook לא הופעל)', replyTo, null);
      return;
    }

    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
    let todayInput = 0, todayOutput = 0, todayCost = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        totalInput += e.input || 0;
        totalOutput += e.output || 0;
        totalCacheRead += e.cache_read || 0;
        totalCacheWrite += e.cache_write || 0;
        totalCost += e.cost_usd || 0;
        if ((e.ts || '').startsWith(today)) {
          todayInput += e.input || 0;
          todayOutput += e.output || 0;
          todayCost += e.cost_usd || 0;
        }
      } catch (_) {}
    }

    const fmt = n => n.toLocaleString('en-US');
    const text = [
      '📊 <b>Token Usage</b>',
      '',
      `<b>היום:</b> ${fmt(todayInput)} in / ${fmt(todayOutput)} out — $${todayCost.toFixed(4)}`,
      `<b>סה"כ:</b> ${fmt(totalInput)} in / ${fmt(totalOutput)} out`,
      `<b>Cache:</b> ${fmt(totalCacheRead)} read / ${fmt(totalCacheWrite)} write`,
      `<b>עלות כוללת:</b> $${totalCost.toFixed(4)}`,
      `<b>קריאות:</b> ${lines.length}`,
    ].join('\n');

    await tgSendMessage(threadId, text, replyTo, null);
  } catch (e) {
    console.error('[stats] Failed:', e.message);
  }
}

// Download a file from Telegram and return its local path
async function downloadTelegramFile(fileId, destPath) {
  const https = require('https');
  // Step 1: get file path
  const info = await new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${fileId}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  if (!info.ok) throw new Error('getFile failed: ' + JSON.stringify(info));
  const filePath = info.result.file_path;
  // Step 2: download
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    https.get(`https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${filePath}`, res => {
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    }).on('error', reject);
  });
  return destPath;
}

// Voice/audio message — transcribe with Whisper if OPENAI_API_KEY set
async function handleVoiceMessage(msg, threadId) {
  const fileId = (msg.voice || msg.audio).file_id;
  const duration = (msg.voice || msg.audio).duration || 0;
  const user = msg.from.first_name || msg.from.username || 'unknown';
  const localFile = `/tmp/relay-voice-${threadId}-${msg.message_id}.ogg`;

  let text;
  try {
    await downloadTelegramFile(fileId, localFile);
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      // Transcribe via Whisper API
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', fs.createReadStream(localFile), { filename: 'voice.ogg', contentType: 'audio/ogg' });
      form.append('model', 'whisper-1');
      const transcription = await new Promise((resolve, reject) => {
        const req = require('https').request('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { ...form.getHeaders(), 'Authorization': `Bearer ${openaiKey}` },
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        form.pipe(req);
      });
      text = transcription.text
        ? `🎤 [Voice ${duration}s]: ${transcription.text}`
        : `🎤 [Voice message ${duration}s — transcription failed]`;
    } else {
      text = `🎤 [Voice message ${duration}s — saved to ${localFile}. Set OPENAI_API_KEY for auto-transcription]`;
    }
  } catch (e) {
    text = `🎤 [Voice message ${duration}s — download failed: ${e.message}]`;
  }

  const queueFile = path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
  const entry = {
    message_id: msg.message_id,
    user,
    user_id: msg.from.id,
    text,
    ts: Math.floor(Date.now() / 1000),
    via: 'webhook',
    media_type: 'voice',
  };
  fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
  console.log(`[voice] ${threadId}: ${user}: ${text.substring(0, 80)}`);
}

// Photo/image message — download and queue with local file path
async function handlePhotoMessage(msg, threadId) {
  const user = msg.from.first_name || msg.from.username || 'unknown';
  const caption = msg.caption || '';

  // Pick highest-resolution photo
  let fileId;
  if (msg.photo) {
    const largest = msg.photo.sort((a, b) => b.file_size - a.file_size)[0];
    fileId = largest.file_id;
  } else {
    fileId = msg.document.file_id;
  }

  const ext = msg.document ? (msg.document.file_name || 'img').split('.').pop() : 'jpg';
  const localFile = `/tmp/relay-photo-${threadId}-${msg.message_id}.${ext}`;

  let text;
  try {
    await downloadTelegramFile(fileId, localFile);
    text = caption
      ? `📷 [Photo: ${localFile}] ${caption}`
      : `📷 [Photo saved to: ${localFile}]`;
  } catch (e) {
    text = `📷 [Photo — download failed: ${e.message}]${caption ? ' ' + caption : ''}`;
  }

  const queueFile = path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
  const entry = {
    message_id: msg.message_id,
    user,
    user_id: msg.from.id,
    text,
    ts: Math.floor(Date.now() / 1000),
    via: 'webhook',
    media_type: 'photo',
    local_path: localFile,
  };
  fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
  console.log(`[photo] ${threadId}: ${user}: ${text.substring(0, 80)}`);
}

// /history command — paginated message history from queue file
const HISTORY_PAGE_SIZE = 12;
const _handledHistoryIds = new Set();

async function handleHistoryCommand(threadId, replyTo, page = 1, editMsgId = null) {
  // Dedup for fresh /history commands (not pagination clicks)
  if (replyTo) {
    const key = `${threadId}:${replyTo}`;
    if (_handledHistoryIds.has(key)) return;
    _handledHistoryIds.add(key);
    setTimeout(() => _handledHistoryIds.delete(key), 30000);
  }

  try {
    const queueFile = path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
    let messages = [];
    if (fs.existsSync(queueFile)) {
      const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          if (m.message_id > 0 && m.text) messages.push(m);
        } catch (_) {}
      }
    }

    if (messages.length === 0) {
      await tgSendMessage(threadId, '📜 אין הודעות בhist', replyTo, null);
      return;
    }

    // Newest first for display
    messages = messages.slice().reverse();
    const totalPages = Math.ceil(messages.length / HISTORY_PAGE_SIZE);
    page = Math.max(1, Math.min(page, totalPages));
    const slice = messages.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE);

    const lines = [`📜 <b>History</b> — עמוד ${page}/${totalPages}`];
    for (const m of slice) {
      const d = new Date(m.ts * 1000);
      const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      const text = (m.text || '').substring(0, 80).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      lines.push(`<code>${time}</code> <b>${m.user}</b>: ${text}`);
    }
    const text = lines.join('\n');

    // Build pagination buttons
    const btns = [];
    if (page > 1) btns.push({ text: '◀ Prev', callback_data: `hist:${threadId}:${page - 1}` });
    btns.push({ text: `${page}/${totalPages}`, callback_data: `hist:${threadId}:${page}` });
    if (page < totalPages) btns.push({ text: 'Next ▶', callback_data: `hist:${threadId}:${page + 1}` });
    const replyMarkup = { inline_keyboard: [btns] };

    if (editMsgId) {
      await tgEditMessage(threadId, editMsgId, text, replyMarkup);
    } else {
      await tgSendMessage(threadId, text, replyTo, replyMarkup);
    }
    console.log(`[history] thread ${threadId} page ${page}/${totalPages}`);
  } catch (e) {
    console.error('[history] Failed:', e.message);
  }
}

async function tgSendMessage(threadId, text, replyTo, replyMarkup) {
  const https = require('https');
  const payload = { chat_id: TG_CHAT_ID, message_thread_id: parseInt(threadId), text, parse_mode: 'HTML' };
  if (replyTo) payload.reply_to_message_id = replyTo;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const body = JSON.stringify(payload);
  await new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function tgEditMessage(threadId, msgId, text, replyMarkup) {
  const https = require('https');
  const payload = { chat_id: TG_CHAT_ID, message_id: msgId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const body = JSON.stringify(payload);
  await new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Forward webhook updates to bot.py for processing (NLP routing, dispatch, mentions, etc.)
function forwardToBot(update) {
  try {
    const http = require('http');
    const data = JSON.stringify(update);
    const req = http.request(BOT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, () => {}); // fire-and-forget
    req.on('error', (e) => console.error('[webhook] Forward to bot error:', e.message));
    req.write(data);
    req.end();
  } catch (e) {
    console.error('[webhook] Forward to bot error:', e.message);
  }
}

// Webhook management endpoints (authed)
app.get('/api/webhook/status', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const https = require('https');
  if (!TG_BOT_TOKEN) return res.json({ error: 'No TELEGRAM_BOT_TOKEN configured' });
  https.get(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getWebhookInfo`, (resp) => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      try { res.json(JSON.parse(data)); } catch { res.json({ raw: data }); }
    });
  }).on('error', e => res.json({ error: e.message }));
});

app.post('/api/webhook/set', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!TG_BOT_TOKEN) return res.json({ error: 'No TELEGRAM_BOT_TOKEN configured' });
  const webhookUrl = `${url}/webhook/${WEBHOOK_SECRET}`;
  const https = require('https');
  const payload = JSON.stringify({
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query', 'message_reaction'],
    drop_pending_updates: false
  });
  const apiReq = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, (resp) => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      try { res.json({ ...JSON.parse(data), webhook_path: `/webhook/${WEBHOOK_SECRET}` }); }
      catch { res.json({ raw: data }); }
    });
  });
  apiReq.on('error', e => res.json({ error: e.message }));
  apiReq.write(payload);
  apiReq.end();
});

app.post('/api/webhook/remove', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!TG_BOT_TOKEN) return res.json({ error: 'No TELEGRAM_BOT_TOKEN configured' });
  const https = require('https');
  https.get(`https://api.telegram.org/bot${TG_BOT_TOKEN}/deleteWebhook`, (resp) => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      try { res.json(JSON.parse(data)); } catch { res.json({ raw: data }); }
    });
  }).on('error', e => res.json({ error: e.message }));
});

// Log webhook secret on startup for setup
if (TG_BOT_TOKEN) {
  console.log(`[webhook] Secret path: /webhook/${WEBHOOK_SECRET}`);
  console.log(`[webhook] Set via: POST /api/webhook/set { "url": "https://your-domain.com" }`);
}

// Apply auth to all routes below
app.use(authMiddleware);

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

// --- Session management (create/delete containers) ---

app.post('/api/session-create', (req, res) => {
  const { session, thread_id, path: workPath, host, type, group, skills } = req.body;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  if (!thread_id) return res.status(400).json({ error: 'thread_id required' });

  try {
    // Check if container already exists
    const exists = execSync(`docker inspect relay-session-${session} 2>/dev/null || true`, { timeout: 5000 }).toString().trim();
    const isEmptyInspect = exists === '' || exists === '[]';
    if (!isEmptyInspect) {
      return res.status(409).json({ error: 'Container already exists' });
    }

    // Add to sessions.json
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (sessions.find(s => s.session === session)) {
      return res.status(409).json({ error: 'Session already in config' });
    }
    const entry = { session, thread_id: parseInt(thread_id), host: host || null, path: workPath || '/root', skills: skills || [], group: group || '' };
    if (type) entry.type = type;
    sessions.push(entry);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));

    // Create container (only for local sessions)
    if (!host) {
      const cmd = `docker run -d --name relay-session-${session} --restart always ` +
        `-v /root:/root -v /var/run/docker.sock:/var/run/docker.sock -v relay-queue:/tmp ` +
        `-e THREAD_ID=${thread_id} -e SESSION_NAME=${session} ` +
        `topix-relay:latest`;
      execSync(cmd, { timeout: 30000 });
    }

    res.json({ ok: true, session, message: host ? 'Added to config (remote)' : 'Container created' });
  } catch (e) { res.status(500).json({ error: 'Create failed: ' + e.message }); }
});

app.post('/api/session-stop', (req, res) => {
  const { session } = req.body;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  try {
    execSync(`docker stop relay-session-${session}`, { timeout: 15000 });
    res.json({ ok: true, session, status: 'stopped' });
  } catch (e) { res.status(500).json({ error: 'Stop failed: ' + e.message }); }
});

app.post('/api/session-delete', (req, res) => {
  const { session } = req.body;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  try {
    // Stop and remove container
    execSync(`docker rm -f relay-session-${session} 2>/dev/null || true`, { timeout: 15000 });

    // Remove from sessions.json
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const filtered = sessions.filter(s => s.session !== session);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(filtered, null, 2));

    res.json({ ok: true, session, message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: 'Delete failed: ' + e.message }); }
});

// --- Templates ---

app.get('/api/templates', (req, res) => {
  try {
    res.type('json').send(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch (e) { res.json([]); }
});

app.post('/api/templates', (req, res) => {
  try {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save templates' }); }
});

app.post('/api/session-from-template', (req, res) => {
  const { template_id, session, thread_id, path: overridePath, host: overrideHost } = req.body;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  if (!thread_id) return res.status(400).json({ error: 'thread_id required' });

  try {
    // Load template
    const templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    const tpl = templates.find(t => t.id === template_id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    // Check if session already exists
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (sessions.find(s => s.session === session)) {
      return res.status(409).json({ error: 'Session already exists' });
    }

    // Build entry from template + overrides
    const entry = {
      session,
      thread_id: parseInt(thread_id),
      host: overrideHost || tpl.host || null,
      path: overridePath || tpl.path || '/root',
      skills: tpl.skills || [],
      group: tpl.group || '',
    };
    if (tpl.type) entry.type = tpl.type;

    sessions.push(entry);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));

    // Create container for local sessions
    if (!entry.host) {
      const cmd = `docker run -d --name relay-session-${session} --restart always ` +
        `-v /root:/root -v /var/run/docker.sock:/var/run/docker.sock -v relay-queue:/tmp ` +
        `-e THREAD_ID=${thread_id} -e SESSION_NAME=${session} ` +
        `topix-relay:latest`;
      execSync(cmd, { timeout: 30000 });
    }

    res.json({ ok: true, session, template: tpl.name, message: entry.host ? 'Added to config (remote)' : 'Container created from template' });
  } catch (e) { res.status(500).json({ error: 'Create from template failed: ' + e.message }); }
});

// --- Auto-scaling ---

app.get('/api/scaling-status', (req, res) => {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const metricsRaw = execSync('bash /relay/scripts/metrics.sh', { timeout: 15000 }).toString();
    const metrics = JSON.parse(metricsRaw);

    const idle = metrics.filter(m => {
      if (m.status !== 'running') return false;
      const ago = m.last_active_ago || '';
      const h = ago.match(/(\d+)h/);
      return h && parseInt(h[1]) >= 2;
    });

    const down = metrics.filter(m => m.status !== 'running');
    const active = metrics.filter(m => {
      if (m.status !== 'running') return false;
      const ago = m.last_active_ago || '';
      const h = ago.match(/(\d+)h/);
      return !h || parseInt(h[1]) < 2;
    });

    res.json({
      total: sessions.length,
      running: metrics.filter(m => m.status === 'running').length,
      active: active.length,
      idle: idle.map(m => m.session),
      down: down.map(m => m.session),
      recommendation: idle.length > 3 ? 'Consider stopping idle sessions to free resources' : 'Healthy',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scale-down', (req, res) => {
  // Stop idle sessions (>2h inactive)
  try {
    const metricsRaw = execSync('bash /relay/scripts/metrics.sh', { timeout: 15000 }).toString();
    const metrics = JSON.parse(metricsRaw);
    const stopped = [];

    // Never stop infrastructure sessions
    const protect = ['relay', 'main', 'copilot'];

    for (const m of metrics) {
      if (m.status !== 'running') continue;
      if (protect.includes(m.session)) continue;
      const ago = m.last_active_ago || '';
      const h = ago.match(/(\d+)h/);
      if (h && parseInt(h[1]) >= 4) {
        try {
          execSync(`docker stop relay-session-${m.session}`, { timeout: 10000 });
          stopped.push(m.session);
        } catch (e) { /* skip */ }
      }
    }
    res.json({ ok: true, stopped, count: stopped.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scale-up', (req, res) => {
  // Restart all stopped sessions
  try {
    const metricsRaw = execSync('bash /relay/scripts/metrics.sh', { timeout: 15000 }).toString();
    const metrics = JSON.parse(metricsRaw);
    const started = [];

    for (const m of metrics) {
      if (m.status === 'running') continue;
      if (m.status === 'not found') continue;
      try {
        execSync(`docker start relay-session-${m.session}`, { timeout: 10000 });
        started.push(m.session);
      } catch (e) { /* skip */ }
    }
    res.json({ ok: true, started, count: started.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/session-health', (req, res) => {
  try {
    const metricsRaw = execSync(METRICS_SCRIPT, { timeout: 15000 }).toString();
    const metrics = JSON.parse(metricsRaw);
    const unhealthy = metrics.filter(m => m.status !== 'running');
    res.json({
      ok: true,
      total: metrics.length,
      healthy: metrics.length - unhealthy.length,
      unhealthy: unhealthy.map(m => ({ session: m.session, status: m.status })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/session-heal', (req, res) => {
  try {
    const metricsRaw = execSync(METRICS_SCRIPT, { timeout: 15000 }).toString();
    const metrics = JSON.parse(metricsRaw);
    const restarted = [];
    for (const m of metrics) {
      if (m.status === 'running') continue;
      if (m.host && m.host !== 'local') continue;
      try {
        execSync(`docker start relay-session-${m.session}`, { timeout: 10000 });
        restarted.push(m.session);
      } catch (e) { /* skip */ }
    }
    const unhealthy = metrics.filter(m => m.status !== 'running');
    res.json({ ok: true, restarted, count: restarted.length, unhealthy: unhealthy.map(m => m.session) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Sessions UI ---
const SESSIONS_HTML = process.env.SESSIONS_HTML || '/relay/sessions-ui.html';
app.get('/sessions', (req, res) => {
  try {
    res.type('html').send(fs.readFileSync(SESSIONS_HTML, 'utf8'));
  } catch (e) { res.status(500).send('Sessions UI not found'); }
});

// --- Session Detail ---

app.get('/api/session-tmux', (req, res) => {
  const session = req.query.session;
  const lines = req.query.lines || 50;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  try {
    const out = execSync(`bash /relay/scripts/session-tmux-capture.sh ${session} ${lines}`, { timeout: 10000 }).toString();
    res.json({ session, output: out.split('\n') });
  } catch (e) { res.status(500).json({ error: 'Failed to capture tmux' }); }
});

app.get('/api/session-queue', (req, res) => {
  const thread_id = req.query.thread_id;
  const max = req.query.max || 50;
  if (!thread_id || !/^\d+$/.test(thread_id)) {
    return res.status(400).json({ error: 'Invalid thread_id' });
  }
  try {
    const out = execSync(`bash /relay/scripts/session-queue.sh ${thread_id} ${max}`, { timeout: 10000 }).toString();
    res.type('json').send(out);
  } catch (e) { res.status(500).json({ error: 'Failed to read queue' }); }
});

app.get('/api/session-tasks', (req, res) => {
  const session = req.query.session;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  try {
    // Read tasks from the MCP server's task store
    const tasksFile = `/tmp/relay-tasks-${session}.json`;
    if (fs.existsSync(tasksFile)) {
      res.type('json').send(fs.readFileSync(tasksFile, 'utf8'));
    } else {
      res.json({});
    }
  } catch (e) { res.status(500).json({ error: 'Failed to read tasks' }); }
});

// Session detail page
const SESSION_DETAIL_HTML = process.env.SESSION_DETAIL_HTML || '/relay/session-detail.html';
app.get('/sessions/:name', (req, res) => {
  try {
    let html = fs.readFileSync(SESSION_DETAIL_HTML, 'utf8');
    html = html.replace('{{SESSION_NAME}}', req.params.name);
    res.type('html').send(html);
  } catch (e) { res.status(500).send('Session detail page not found'); }
});

// --- Task Dashboard ---
const TASKS_HTML = process.env.TASKS_HTML || '/relay/tasks-dashboard.html';
app.get('/tasks', (req, res) => {
  try {
    res.type('html').send(fs.readFileSync(TASKS_HTML, 'utf8'));
  } catch (e) { res.status(500).send('Tasks dashboard not found'); }
});

app.get('/api/tasks-all', (req, res) => {
  try {
    const out = execSync('bash /relay/scripts/aggregate-tasks.sh /relay/sessions.json', { timeout: 10000 }).toString();
    res.type('json').send(out);
  } catch (e) { res.json({}); }
});

// --- Orchestrator ---
const ORCH_STATE_FILE = '/tmp/orchestrator-state.json';
const HEARTBEAT_DIR = '/tmp';

function loadOrchState() {
  try {
    return JSON.parse(fs.readFileSync(ORCH_STATE_FILE, 'utf8'));
  } catch {
    return { tasks: [], assignments: {}, log: [], lastRun: null };
  }
}

function saveOrchState(state) {
  fs.writeFileSync(ORCH_STATE_FILE, JSON.stringify(state, null, 2));
}

function getHeartbeats() {
  const beats = {};
  try {
    const files = fs.readdirSync(HEARTBEAT_DIR).filter(f => f.startsWith('heartbeat-') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(HEARTBEAT_DIR, f), 'utf8'));
        beats[data.session] = data;
      } catch {}
    }
  } catch {}
  return beats;
}

function getSessionSkills() {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const map = {};
    for (const s of sessions) map[s.session] = s.skills || [];
    return map;
  } catch { return {}; }
}

function scoreSessions(task, heartbeats, skillsMap) {
  const candidates = [];
  const requiredSkills = task.skills || [];
  const now = Date.now();

  for (const [session, hb] of Object.entries(heartbeats)) {
    // Skip sessions that reported busy
    if (hb.status === 'busy') continue;
    // Must be recent heartbeat (within 5 min)
    const age = now - (hb.ts || 0);
    if (age > 5 * 60 * 1000) continue;

    const skills = skillsMap[session] || [];
    let score = 0;
    // Skill match scoring
    for (const sk of requiredSkills) {
      if (skills.includes(sk)) score += 5;
    }
    // Prefer idle sessions
    if (hb.status === 'idle') score += 3;
    if (hb.status === 'ready') score += 2;
    // Explicit target
    if (task.target === session) score += 20;

    if (score > 0 || requiredSkills.length === 0) {
      candidates.push({ session, score, status: hb.status });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function writeToQueue(session, text) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const target = sessions.find(s => s.session === session);
    if (!target) return false;
    const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`;
    const entry = JSON.stringify({
      text,
      user: 'orchestrator',
      message_id: -Date.now(),
      thread_id: target.thread_id,
      ts: Date.now() / 1000,
      force: true
    });
    fs.appendFileSync(queueFile, entry + '\n');
    return true;
  } catch { return false; }
}

// Orchestrator loop — runs every 30s
function orchestratorTick() {
  const state = loadOrchState();
  const heartbeats = getHeartbeats();
  const skillsMap = getSessionSkills();
  const now = Date.now();

  // Process pending tasks
  for (const task of state.tasks) {
    if (task.status !== 'pending') continue;

    // Check if already assigned
    if (state.assignments[task.id]) continue;

    // Score and pick best session
    const candidates = scoreSessions(task, heartbeats, skillsMap);
    if (candidates.length === 0) continue;

    const best = candidates[0];
    task.status = 'assigned';
    task.assigned_to = best.session;
    task.assigned_at = now;
    state.assignments[task.id] = best.session;

    // Send task to session
    const msg = `[Orchestrator] משימה חדשה:\n\n<b>${task.title || 'Task'}</b>\n${task.description || ''}\n\nTask ID: <code>${task.id}</code>\nכשסיים, שלח: <code>complete_task("${task.id}", "result")</code>`;
    writeToQueue(best.session, msg);

    state.log.push({
      ts: now,
      action: 'assign',
      task_id: task.id,
      session: best.session,
      score: best.score
    });
  }

  // Check for timed-out tasks (>30 min without completion)
  for (const task of state.tasks) {
    if (task.status !== 'assigned') continue;
    if (now - (task.assigned_at || 0) > 30 * 60 * 1000) {
      task.status = 'timeout';
      state.log.push({ ts: now, action: 'timeout', task_id: task.id, session: task.assigned_to });
    }
  }

  // Keep log trimmed to last 100 entries
  if (state.log.length > 100) state.log = state.log.slice(-100);

  state.lastRun = now;
  saveOrchState(state);
}

// Start orchestrator loop
setInterval(orchestratorTick, 30000);
// Run immediately on startup
setTimeout(orchestratorTick, 2000);

// Heartbeat endpoint — sessions call this to report status
app.post('/api/heartbeat', (req, res) => {
  const { session, status } = req.body;
  if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  const hbFile = path.join(HEARTBEAT_DIR, `heartbeat-${session}.json`);
  const data = { session, status: status || 'ready', ts: Date.now(), uptime: req.body.uptime || 0, tasks_completed: req.body.tasks_completed || 0 };
  fs.writeFileSync(hbFile, JSON.stringify(data));
  res.json({ ok: true });
});

// Submit task to orchestrator
app.post('/api/orchestrator/task', (req, res) => {
  const { title, description, skills, target, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const state = loadOrchState();
  const task = {
    id: `orch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    description: description || '',
    skills: skills || [],
    target: target || null,
    priority: priority || 'normal',
    status: 'pending',
    created_at: Date.now(),
  };
  state.tasks.push(task);
  saveOrchState(state);

  // Trigger immediate assignment
  orchestratorTick();

  const updated = loadOrchState();
  const t = updated.tasks.find(t => t.id === task.id);
  res.json({ ok: true, task: t });
});

// Complete task
app.post('/api/orchestrator/complete', (req, res) => {
  const { task_id, result, session } = req.body;
  if (!task_id) return res.status(400).json({ error: 'task_id required' });

  const state = loadOrchState();
  const task = state.tasks.find(t => t.id === task_id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  task.status = 'complete';
  task.result = result || '';
  task.completed_at = Date.now();
  task.completed_by = session || task.assigned_to;

  state.log.push({ ts: Date.now(), action: 'complete', task_id, session: task.completed_by });
  saveOrchState(state);

  res.json({ ok: true, task });
});

// Load MCP agent-tasks (peer-to-peer tasks from send_task)
function loadAgentTasks() {
  try {
    const data = JSON.parse(fs.readFileSync('/tmp/agent-tasks.json', 'utf8'));
    return Object.entries(data).map(([id, t]) => ({
      id,
      title: (t.prompt || '').substring(0, 80),
      description: t.prompt || '',
      status: t.status === 'complete' ? 'complete' : t.status === 'waiting' ? 'pending' : t.status === 'error' ? 'timeout' : 'assigned',
      assigned_to: t.to,
      created_at: (t.created || 0) * 1000,
      source: 'mcp',
      from: t.from,
      result: t.result || '',
    }));
  } catch { return []; }
}

// Get orchestrator status
app.get('/api/orchestrator/status', (req, res) => {
  const state = loadOrchState();
  const heartbeats = getHeartbeats();
  const agentTasks = loadAgentTasks();

  // Merge orchestrator tasks + MCP agent tasks
  const allTasks = [...state.tasks.map(t => ({ ...t, source: 'orchestrator' })), ...agentTasks];

  const pending = allTasks.filter(t => t.status === 'pending').length;
  const assigned = allTasks.filter(t => t.status === 'assigned').length;
  const complete = allTasks.filter(t => t.status === 'complete').length;
  const timeout = allTasks.filter(t => t.status === 'timeout').length;

  const aliveSessions = Object.entries(heartbeats)
    .filter(([_, hb]) => Date.now() - (hb.ts || 0) < 5 * 60 * 1000)
    .map(([name, hb]) => ({ session: name, status: hb.status, age: Math.round((Date.now() - hb.ts) / 1000) }));

  res.json({
    tasks: { total: allTasks.length, pending, assigned, complete, timeout },
    sessions: { alive: aliveSessions.length, details: aliveSessions },
    lastRun: state.lastRun,
    recentLog: state.log.slice(-20),
    allTasks,
  });
});

// Orchestrator dashboard
const ORCH_HTML = process.env.ORCH_HTML || '/relay/orchestrator.html';
app.get('/orchestrator', (req, res) => {
  try {
    res.type('html').send(fs.readFileSync(ORCH_HTML, 'utf8'));
  } catch (e) { res.status(500).send('Orchestrator dashboard not found'); }
});

// --- NLP Auto-Routing ---
// Keyword/intent detection for automatic task routing to best session

const ROUTING_RULES = [
  // Infrastructure & DevOps
  { keywords: ['docker', 'container', 'deploy', 'kubernetes', 'k8s', 'nginx', 'server', 'infra', 'devops', 'ci/cd', 'pipeline', 'build', 'image'],
    skills: ['devops', 'docker', 'infra'], weight: 5 },
  // Python
  { keywords: ['python', 'pip', 'flask', 'django', 'fastapi', 'pandas', 'numpy', 'pytest', 'venv'],
    skills: ['python'], weight: 5 },
  // JavaScript/TypeScript
  { keywords: ['javascript', 'typescript', 'node', 'npm', 'react', 'vue', 'next', 'bun', 'express', 'jest'],
    skills: ['javascript', 'typescript', 'frontend'], weight: 5 },
  // Git
  { keywords: ['git', 'commit', 'branch', 'merge', 'rebase', 'pr', 'pull request', 'github'],
    skills: ['git'], weight: 4 },
  // Database
  { keywords: ['database', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'migration', 'schema', 'query'],
    skills: ['database', 'sql'], weight: 5 },
  // Testing
  { keywords: ['test', 'testing', 'unit test', 'integration test', 'e2e', 'coverage', 'qa'],
    skills: ['testing', 'qa'], weight: 4 },
  // Security
  { keywords: ['security', 'auth', 'authentication', 'ssl', 'tls', 'certificate', 'vulnerability', 'firewall'],
    skills: ['security'], weight: 5 },
  // Documentation
  { keywords: ['docs', 'documentation', 'readme', 'api docs', 'swagger', 'openapi'],
    skills: ['docs', 'writing'], weight: 3 },
  // General admin
  { keywords: ['admin', 'config', 'settings', 'monitoring', 'logs', 'debug', 'troubleshoot'],
    skills: ['admin', 'general'], weight: 3 },
];

function nlpDetectSkills(text) {
  const lower = text.toLowerCase();
  const detected = {};

  for (const rule of ROUTING_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) {
        for (const skill of rule.skills) {
          detected[skill] = (detected[skill] || 0) + rule.weight;
        }
        break; // Only match first keyword per rule
      }
    }
  }

  // Sort by score
  return Object.entries(detected)
    .sort((a, b) => b[1] - a[1])
    .map(([skill, score]) => ({ skill, score }));
}

function nlpRouteTask(text) {
  const detectedSkills = nlpDetectSkills(text);
  if (detectedSkills.length === 0) return { skills: [], reason: 'No specific skills detected' };

  const topSkills = detectedSkills.slice(0, 3).map(d => d.skill);

  // Score sessions
  const heartbeats = getHeartbeats();
  const skillsMap = getSessionSkills();
  const candidates = [];

  for (const [session, hb] of Object.entries(heartbeats)) {
    const age = Date.now() - (hb.ts || 0);
    if (age > 5 * 60 * 1000) continue; // stale heartbeat

    const sessionSkills = skillsMap[session] || [];
    let score = 0;

    // Skill match
    for (const ds of detectedSkills) {
      if (sessionSkills.includes(ds.skill)) score += ds.score;
    }

    // Availability bonus
    if (hb.status === 'idle') score += 3;
    if (hb.status === 'ready') score += 2;
    if (hb.status === 'busy') score -= 5;

    if (score > 0) {
      candidates.push({ session, score, status: hb.status, matchedSkills: sessionSkills.filter(s => topSkills.includes(s)) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return {
    skills: topSkills,
    detectedSkills,
    candidates,
    best: candidates[0] || null,
    reason: candidates.length > 0
      ? `Best match: ${candidates[0].session} (score: ${candidates[0].score}, skills: ${candidates[0].matchedSkills.join(', ')})`
      : 'No available sessions match detected skills',
  };
}

// NLP Route analysis endpoint (dry-run — shows routing without dispatching)
app.post('/api/nlp/analyze', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  res.json(nlpRouteTask(text));
});

// NLP Auto-route endpoint — analyzes and dispatches
app.post('/api/nlp/route', (req, res) => {
  const { text, title } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const routing = nlpRouteTask(text);
  if (!routing.best) {
    return res.json({ ok: false, routing, error: 'No matching session found' });
  }

  // Create orchestrator task with routing
  const state = loadOrchState();
  const task = {
    id: `nlp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: title || text.substring(0, 60),
    description: text,
    skills: routing.skills,
    target: routing.best.session,
    priority: 'normal',
    status: 'pending',
    created_at: Date.now(),
    routed_by: 'nlp',
    routing_score: routing.best.score,
    routing_reason: routing.reason,
  };
  state.tasks.push(task);
  saveOrchState(state);
  orchestratorTick();

  const updated = loadOrchState();
  const t = updated.tasks.find(t => t.id === task.id);
  res.json({ ok: true, routing, task: t });
});

// NLP routing rules (for dashboard display)
app.get('/api/nlp/rules', (req, res) => {
  res.json({ rules: ROUTING_RULES });
});

// --- Pipeline System ---
const PIPELINE_STATE_FILE = '/tmp/pipeline-state.json';

function loadPipelineState() {
  try {
    return JSON.parse(fs.readFileSync(PIPELINE_STATE_FILE, 'utf8'));
  } catch {
    return { pipelines: {}, templates: {} };
  }
}

function savePipelineState(state) {
  fs.writeFileSync(PIPELINE_STATE_FILE, JSON.stringify(state, null, 2));
}

// Create pipeline from definition
app.post('/api/pipeline/create', (req, res) => {
  const { name, steps, save_template } = req.body;
  if (!name || !steps || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'name and steps[] required' });
  }

  const state = loadPipelineState();
  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const pipeline = {
    id: pipelineId,
    name,
    status: 'running',
    created_at: Date.now(),
    current_step: 0,
    steps: steps.map((s, i) => ({
      index: i,
      task: s.task || `Step ${i + 1}`,
      target: s.to || s.target || 'auto',
      skills: s.skills || [],
      approve: s.approve || false,
      status: 'pending',
      task_id: null,
      result: null,
      prev_result: null,
      started_at: null,
      completed_at: null,
    })),
    log: [{ ts: Date.now(), action: 'created', detail: `Pipeline '${name}' with ${steps.length} steps` }],
  };

  state.pipelines[pipelineId] = pipeline;

  // Save as template if requested
  if (save_template) {
    state.templates[name] = steps;
  }

  savePipelineState(state);

  // Trigger first step
  pipelineAdvance(pipelineId);

  res.json({ ok: true, pipeline_id: pipelineId, pipeline: loadPipelineState().pipelines[pipelineId] });
});

// Advance a pipeline — dispatch next pending step
function pipelineAdvance(pipelineId) {
  const state = loadPipelineState();
  const pipeline = state.pipelines[pipelineId];
  if (!pipeline || pipeline.status !== 'running') return;

  // Find next pending step
  const step = pipeline.steps.find(s => s.status === 'pending');
  if (!step) {
    // All steps done — check if all complete
    const allDone = pipeline.steps.every(s => s.status === 'complete' || s.status === 'skipped');
    if (allDone) {
      pipeline.status = 'complete';
      pipeline.completed_at = Date.now();
      pipeline.log.push({ ts: Date.now(), action: 'complete', detail: 'All steps completed' });
    }
    savePipelineState(state);
    return;
  }

  // If step requires approval, set to 'awaiting_approval'
  if (step.approve && step.status === 'pending') {
    step.status = 'awaiting_approval';
    pipeline.log.push({ ts: Date.now(), action: 'awaiting_approval', step: step.index, detail: step.task });
    savePipelineState(state);
    return;
  }

  // Get previous step result for forwarding
  const prevIdx = step.index - 1;
  if (prevIdx >= 0 && pipeline.steps[prevIdx].result) {
    step.prev_result = pipeline.steps[prevIdx].result;
  }

  // Build task prompt with context
  let prompt = step.task;
  if (step.prev_result) {
    prompt = `[Pipeline: ${pipeline.name} | Step ${step.index + 1}/${pipeline.steps.length}]\n\n${step.task}\n\n[Previous step result]:\n${step.prev_result}`;
  } else {
    prompt = `[Pipeline: ${pipeline.name} | Step ${step.index + 1}/${pipeline.steps.length}]\n\n${step.task}`;
  }

  // Submit as orchestrator task
  const orchState = loadOrchState();
  const taskId = `pipe-task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const orchTask = {
    id: taskId,
    title: `[${pipeline.name}] ${step.task.substring(0, 60)}`,
    description: prompt,
    skills: step.skills,
    target: step.target === 'auto' ? null : step.target,
    priority: 'high',
    status: 'pending',
    created_at: Date.now(),
    pipeline_id: pipelineId,
    pipeline_step: step.index,
  };
  orchState.tasks.push(orchTask);
  saveOrchState(orchState);

  // Update step
  step.status = 'assigned';
  step.task_id = taskId;
  step.started_at = Date.now();
  pipeline.current_step = step.index;
  pipeline.log.push({ ts: Date.now(), action: 'dispatch', step: step.index, task_id: taskId, detail: step.task });
  savePipelineState(state);

  // Trigger orchestrator to assign it
  orchestratorTick();
}

// Pipeline tick — check for completed steps and advance
function pipelineTick() {
  const state = loadPipelineState();
  const orchState = loadOrchState();
  let changed = false;

  for (const [pipelineId, pipeline] of Object.entries(state.pipelines)) {
    if (pipeline.status !== 'running') continue;

    for (const step of pipeline.steps) {
      if (step.status !== 'assigned' || !step.task_id) continue;

      // Check if the orchestrator task completed
      const orchTask = orchState.tasks.find(t => t.id === step.task_id);
      if (!orchTask) continue;

      if (orchTask.status === 'complete') {
        step.status = 'complete';
        step.result = orchTask.result || '';
        step.completed_at = Date.now();
        pipeline.log.push({ ts: Date.now(), action: 'step_complete', step: step.index, detail: step.task });
        changed = true;
      } else if (orchTask.status === 'timeout') {
        step.status = 'failed';
        step.result = 'Timeout';
        pipeline.status = 'failed';
        pipeline.log.push({ ts: Date.now(), action: 'step_failed', step: step.index, detail: 'Timeout' });
        changed = true;
      }
    }

    // Check MCP agent-tasks for pipeline task completions
    try {
      const agentTasks = JSON.parse(fs.readFileSync('/tmp/agent-tasks.json', 'utf8'));
      for (const step of pipeline.steps) {
        if (step.status !== 'assigned' || !step.task_id) continue;
        const agentTask = agentTasks[step.task_id];
        if (agentTask && agentTask.status === 'complete') {
          step.status = 'complete';
          step.result = agentTask.result || agentTask.output || '';
          step.completed_at = Date.now();
          pipeline.log.push({ ts: Date.now(), action: 'step_complete', step: step.index, detail: step.task });
          changed = true;
        }
      }
    } catch {}

    // Advance to next step if current completed
    if (changed && pipeline.status === 'running') {
      savePipelineState(state);
      pipelineAdvance(pipelineId);
      return; // Re-read state after advance
    }
  }

  if (changed) savePipelineState(state);
}

// Run pipeline tick alongside orchestrator tick
setInterval(pipelineTick, 15000);

// Approve a pipeline step
app.post('/api/pipeline/approve', (req, res) => {
  const { pipeline_id, step } = req.body;
  if (!pipeline_id) return res.status(400).json({ error: 'pipeline_id required' });

  const state = loadPipelineState();
  const pipeline = state.pipelines[pipeline_id];
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });

  const stepIdx = step !== undefined ? step : pipeline.steps.findIndex(s => s.status === 'awaiting_approval');
  if (stepIdx < 0 || stepIdx >= pipeline.steps.length) return res.status(400).json({ error: 'No step awaiting approval' });

  const s = pipeline.steps[stepIdx];
  if (s.status !== 'awaiting_approval') return res.status(400).json({ error: `Step ${stepIdx} is ${s.status}, not awaiting approval` });

  s.status = 'pending';
  pipeline.log.push({ ts: Date.now(), action: 'approved', step: stepIdx, detail: s.task });
  savePipelineState(state);

  // Advance
  pipelineAdvance(pipeline_id);
  res.json({ ok: true, pipeline: loadPipelineState().pipelines[pipeline_id] });
});

// Cancel/abort a pipeline
app.post('/api/pipeline/cancel', (req, res) => {
  const { pipeline_id } = req.body;
  if (!pipeline_id) return res.status(400).json({ error: 'pipeline_id required' });

  const state = loadPipelineState();
  const pipeline = state.pipelines[pipeline_id];
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });

  pipeline.status = 'cancelled';
  pipeline.log.push({ ts: Date.now(), action: 'cancelled', detail: 'Pipeline cancelled by user' });
  // Cancel any assigned steps
  for (const s of pipeline.steps) {
    if (s.status === 'assigned' || s.status === 'pending' || s.status === 'awaiting_approval') {
      s.status = 'skipped';
    }
  }
  savePipelineState(state);
  res.json({ ok: true, pipeline });
});

// Retry a failed pipeline from the failed step
app.post('/api/pipeline/retry', (req, res) => {
  const { pipeline_id } = req.body;
  if (!pipeline_id) return res.status(400).json({ error: 'pipeline_id required' });

  const state = loadPipelineState();
  const pipeline = state.pipelines[pipeline_id];
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
  if (pipeline.status !== 'failed') return res.status(400).json({ error: 'Pipeline is not failed' });

  // Reset failed step to pending
  const failedStep = pipeline.steps.find(s => s.status === 'failed');
  if (failedStep) {
    failedStep.status = 'pending';
    failedStep.task_id = null;
    failedStep.result = null;
    failedStep.started_at = null;
  }
  pipeline.status = 'running';
  pipeline.log.push({ ts: Date.now(), action: 'retry', detail: `Retrying from step ${failedStep?.index}` });
  savePipelineState(state);

  pipelineAdvance(pipeline_id);
  res.json({ ok: true, pipeline: loadPipelineState().pipelines[pipeline_id] });
});

// List pipelines + templates
app.get('/api/pipeline/status', (req, res) => {
  const state = loadPipelineState();
  const pipelines = Object.values(state.pipelines).map(p => ({
    ...p,
    progress: `${p.steps.filter(s => s.status === 'complete').length}/${p.steps.length}`,
  }));
  res.json({ pipelines, templates: state.templates });
});

// Get single pipeline
app.get('/api/pipeline/:id', (req, res) => {
  const state = loadPipelineState();
  const pipeline = state.pipelines[req.params.id];
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
  res.json(pipeline);
});

// Create pipeline from saved template
app.post('/api/pipeline/from-template', (req, res) => {
  const { template, name } = req.body;
  if (!template) return res.status(400).json({ error: 'template name required' });

  const state = loadPipelineState();
  const steps = state.templates[template];
  if (!steps) return res.status(404).json({ error: `Template '${template}' not found` });

  // Forward to create endpoint logic
  req.body = { name: name || template, steps };
  // Re-emit
  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const pipeline = {
    id: pipelineId,
    name: name || template,
    status: 'running',
    created_at: Date.now(),
    current_step: 0,
    steps: steps.map((s, i) => ({
      index: i,
      task: s.task || `Step ${i + 1}`,
      target: s.to || s.target || 'auto',
      skills: s.skills || [],
      approve: s.approve || false,
      status: 'pending',
      task_id: null,
      result: null,
      prev_result: null,
      started_at: null,
      completed_at: null,
    })),
    log: [{ ts: Date.now(), action: 'created', detail: `Pipeline from template '${template}'` }],
  };
  state.pipelines[pipelineId] = pipeline;
  savePipelineState(state);
  pipelineAdvance(pipelineId);
  res.json({ ok: true, pipeline_id: pipelineId, pipeline: loadPipelineState().pipelines[pipelineId] });
});

// Pipeline dashboard
app.get('/pipeline', (req, res) => {
  try {
    res.type('html').send(fs.readFileSync('/relay/pipeline.html', 'utf8'));
  } catch (e) { res.status(500).send('Pipeline dashboard not found'); }
});

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// --- Proxy everything else to nomacode (web terminal) ---
app.use('/', createProxyMiddleware({
  target: NOMACODE_URL,
  changeOrigin: true,
  ws: true,
  // Re-stream JSON body that express.json() already consumed
  onProxyReq: (proxyReq, req) => {
    if (req.body && Object.keys(req.body).length > 0) {
      const body = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
      proxyReq.write(body);
    }
  },
}));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Relay API server listening on port ${PORT}, proxying to ${NOMACODE_URL}`);
});

// WebSocket upgrade for terminal
server.on('upgrade', (req, socket, head) => {
  const proxy = createProxyMiddleware({ target: NOMACODE_URL, ws: true });
  proxy.upgrade(req, socket, head);
});

// ── Scheduled Tasks ───────────────────────────────────────────────────────────
// Reads /relay/schedules.json every minute and fires due tasks.
//
// schedules.json format:
// [
//   {
//     "id": "daily-standup",
//     "cron": "0 9 * * 1-5",        // standard 5-field cron (min hour dom mon dow)
//     "thread_id": 183,
//     "message": "בוקר טוב! מה התוכנית להיום?",
//     "enabled": true
//   }
// ]
const SCHEDULES_FILE = process.env.SCHEDULES_FILE || '/relay/schedules.json';

function parseCronField(field, value, min, max) {
  if (field === '*') return true;
  if (field.includes('/')) {
    const [, step] = field.split('/');
    return value % parseInt(step) === 0;
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }
  return parseInt(field) === value;
}

function cronMatches(cronExpr, date) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    parseCronField(min,  date.getMinutes(),  0, 59) &&
    parseCronField(hour, date.getHours(),    0, 23) &&
    parseCronField(dom,  date.getDate(),     1, 31) &&
    parseCronField(mon,  date.getMonth() + 1, 1, 12) &&
    parseCronField(dow,  date.getDay(),      0,  6)
  );
}

function tickScheduler() {
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) return;
    const schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    const now = new Date();
    for (const sched of schedules) {
      if (!sched.enabled) continue;
      if (!cronMatches(sched.cron, now)) continue;
      const queueFile = path.join(QUEUE_DIR, `tg-queue-${sched.thread_id}.jsonl`);
      const entry = {
        message_id: -(Math.floor(Date.now() / 1000) % 2147483647),
        user: 'scheduler',
        text: sched.message,
        ts: Math.floor(Date.now() / 1000),
        via: 'scheduler',
        schedule_id: sched.id,
        force: true,
      };
      fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
      console.log(`[scheduler] Fired "${sched.id}" → thread ${sched.thread_id}: ${sched.message.substring(0, 60)}`);
    }
  } catch (e) {
    console.error('[scheduler] Error:', e.message);
  }
}

// Tick every minute, aligned to the minute boundary
function startScheduler() {
  const msToNextMinute = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds();
  setTimeout(() => {
    tickScheduler();
    setInterval(tickScheduler, 60000);
  }, msToNextMinute);
  console.log('[scheduler] Started — first tick in', Math.round(msToNextMinute / 1000), 's');
}
startScheduler();

// Live logs — Server-Sent Events stream of docker container logs
app.get('/api/logs/:container', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const container = req.params.container.replace(/[^a-zA-Z0-9_-]/g, '');
  const tail = parseInt(req.query.tail || '50');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { spawn } = require('child_process');
  const proc = spawn('docker', ['logs', '--tail', String(tail), '-f', `relay-session-${container}`]);

  const send = (data) => {
    const escaped = data.replace(/\n/g, '\\n').replace(/\r/g, '');
    res.write(`data: ${escaped}\n\n`);
  };

  proc.stdout.on('data', d => send(d.toString()));
  proc.stderr.on('data', d => send(d.toString()));
  proc.on('close', () => { res.write('data: [stream ended]\n\n'); res.end(); });
  req.on('close', () => proc.kill());
});

// Tool call timeline — read session JSONL and extract tool calls
app.get('/api/timeline/:session', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sessionName = req.params.session.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === sessionName);
    if (!session) return res.status(404).json({ error: 'session not found' });

    const projectKey = session.path.replace(/\//g, '-').replace(/[^a-zA-Z0-9._-]/g, '-');
    const projectDir = `/root/.claude/projects/${projectKey}`;
    const latest = fs.existsSync(projectDir)
      ? fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')).sort().pop()
      : null;

    if (!latest) return res.json([]);

    const events = [];
    const lines = fs.readFileSync(path.join(projectDir, latest), 'utf8').split('\n').filter(l => l.trim());
    for (const line of lines.slice(-200)) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'tool_use' || (d.type === 'assistant' && d.message?.content)) {
          const content = d.message?.content || [];
          for (const block of (Array.isArray(content) ? content : [])) {
            if (block.type === 'tool_use') {
              events.push({ ts: d.timestamp, tool: block.name, input: JSON.stringify(block.input || {}).slice(0, 120) });
            }
          }
        }
      } catch (_) {}
    }
    res.json(events.slice(-50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// API endpoints for schedules
app.get('/api/schedules', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const schedules = fs.existsSync(SCHEDULES_FILE) ? JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')) : [];
    res.json(schedules);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedules', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const schedules = fs.existsSync(SCHEDULES_FILE) ? JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')) : [];
    const sched = req.body;
    if (!sched.id || !sched.cron || !sched.thread_id || !sched.message) {
      return res.status(400).json({ error: 'id, cron, thread_id, message required' });
    }
    const idx = schedules.findIndex(s => s.id === sched.id);
    if (idx >= 0) schedules[idx] = sched;
    else schedules.push(sched);
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    res.json({ ok: true, schedule: sched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/schedules/:id', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const schedules = fs.existsSync(SCHEDULES_FILE) ? JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')) : [];
    const filtered = schedules.filter(s => s.id !== req.params.id);
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(filtered, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
