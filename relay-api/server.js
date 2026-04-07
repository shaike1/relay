const express = require('express');
const { execSync } = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');

// ── Error reporter ────────────────────────────────────────────────────────────
// Catches unhandled errors and:
//   1. Appends to /tmp/relay-errors.jsonl
//   2. Sends a Telegram alert to ALERT_THREAD_ID (or first session's thread_id)
//
const ERROR_LOG = process.env.ERROR_LOG || '/tmp/relay-errors.jsonl';
const ALERT_THREAD_ID = process.env.ALERT_THREAD_ID || null;

function _alertThreadId() {
  if (ALERT_THREAD_ID) return ALERT_THREAD_ID;
  try {
    const sf = process.env.SESSIONS_FILE || '/relay/sessions.json';
    const sessions = JSON.parse(fs.readFileSync(sf, 'utf8'));
    if (sessions.length > 0) return sessions[0].thread_id;
  } catch (_) {}
  return null;
}

function reportError(type, err) {
  const entry = {
    t: new Date().toISOString(),
    type,
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
  };
  try { fs.appendFileSync(ERROR_LOG, JSON.stringify(entry) + '\n'); } catch (_) {}

  // Send Telegram alert (best-effort, non-blocking)
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.GROUP_CHAT_ID;
  const threadId = _alertThreadId();
  if (token && chatId && threadId) {
    const text = `⚠️ <b>relay-api error</b> [${type}]\n<code>${entry.message.substring(0, 300)}</code>`;
    const body = JSON.stringify({
      chat_id: chatId,
      message_thread_id: Number(threadId),
      text,
      parse_mode: 'HTML',
    });
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }
}

// ── Direct user notifications ─────────────────────────────────────────────────
// notifyUser(text) — sends a DM to NOTIFY_USER_ID (if set).
// Used for critical events: crashes, errors, backup completion, etc.
const NOTIFY_USER_ID = process.env.NOTIFY_USER_ID || null;

function notifyUser(text, urgent = true) {
  if (!NOTIFY_USER_ID) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const body = JSON.stringify({
    chat_id: NOTIFY_USER_ID,
    text,
    parse_mode: 'HTML',
    disable_notification: !urgent,
  });
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}
// ─────────────────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[error-reporter] uncaughtException:', err);
  reportError('uncaughtException', err);
  notifyUser(`🚨 <b>relay-api uncaught exception</b>\n<code>${String(err.message || err).substring(0, 300)}</code>`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[error-reporter] unhandledRejection:', reason);
  const err = reason instanceof Error ? reason : new Error(String(reason));
  reportError('unhandledRejection', err);
  notifyUser(`🚨 <b>relay-api unhandled rejection</b>\n<code>${String(err.message).substring(0, 300)}</code>`);
});
// ─────────────────────────────────────────────────────────────────────────────

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
  if (req.path === '/health' || req.path === '/health/sessions') return next();
  // Allow login page
  if (req.path === '/login') return next();
  // Allow Mini App endpoints — authenticated via Telegram initData instead
  if (req.path === '/miniapp' || req.path.startsWith('/miniapp/')) return next();
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

// --- GitHub Webhook config ---
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const GITHUB_DEFAULT_THREAD_ID = process.env.GITHUB_DEFAULT_THREAD_ID || '';

// --- Generic Webhook config ---
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

// --- Self-registration config ---
const ALLOW_SELF_REGISTER = (process.env.ALLOW_SELF_REGISTER || 'false').toLowerCase() === 'true';
const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL || 'http://relay:18793/tg';

// --- Rate limiter: 30 messages per minute per user ---
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const _rateLimitMap = new Map(); // userId → number[]

function checkRateLimit(userId) {
  const now = Date.now();
  const timestamps = (_rateLimitMap.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    _rateLimitMap.set(userId, timestamps);
    return false; // rate limited
  }
  timestamps.push(now);
  _rateLimitMap.set(userId, timestamps);
  return true; // allowed
}

// Merge buffer: coalesces rapid sequential messages from the same user
// Map<userId, {timer, messages[], threadId, firstEntry}>
const _mergeBuffer = new Map();
const MERGE_DELAY_MS = 1500;

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

  // Feature 4: Self-registration — if no session configured for this thread, auto-create or notify
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const existingSession = sessions.find(s => String(s.thread_id) === String(threadId));
    if (!existingSession) {
      const userName = (msg.from && (msg.from.username || msg.from.first_name)) || `user${msg.from && msg.from.id || threadId}`;
      if (ALLOW_SELF_REGISTER) {
        // Auto-create new session entry
        const newSession = {
          thread_id: threadId,
          session: userName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase(),
          type: 'claude',
          path: `/root/sessions/${userName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()}`,
          auto_registered: true,
          registered_at: new Date().toISOString(),
        };
        sessions.push(newSession);
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
        console.log(`[self-register] Auto-registered thread ${threadId} as session "${newSession.session}"`);
        tgSendMessage(threadId,
          `👋 ברוך הבא! Session חדש נוצר אוטומטית עבורך: <code>${newSession.session}</code>\nמוכן לעבוד!`,
          null, null
        ).catch(() => {});
        // Continue to queue the message normally
      } else {
        tgSendMessage(threadId,
          `❌ סשן לא מוגדר לטופיק זה — צור קשר עם המנהל`,
          null, null
        ).catch(() => {});
        return;
      }
    }
  } catch (e) {
    console.error('[self-register] Error:', e.message);
  }

  // /start — welcome message with Mini App button
  if (msg.text && /^\/start(@\S+)?$/i.test(msg.text.trim())) {
    const miniappDomain = process.env.MINIAPP_DOMAIN || (() => {
      const wu = process.env.WEBHOOK_URL || '';
      const m = wu.match(/^(https?:\/\/[^\/]+)/);
      return m ? m[1] : null;
    })();
    const miniappUrl = miniappDomain ? `${miniappDomain}/miniapp` : null;
    const replyMarkup = miniappUrl ? {
      inline_keyboard: [[{ text: '📱 Open Relay App', web_app: { url: miniappUrl } }]]
    } : null;
    tgSendMessage(
      threadId,
      '👋 <b>ברוך הבא ל-Relay!</b>\nשלח הודעות לסשן הפעיל, או פתח את האפליקציה לניהול כל הסשנים.',
      msg.message_id,
      replyMarkup
    ).catch(() => {});
    return;
  }

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

  // /cancel — send SIGINT to Claude in the session container
  if (msg.text && /^\/cancel(@\S+)?$/i.test(msg.text.trim())) {
    handleCancelCommand(threadId, msg.message_id).catch(e => console.error('[cancel] error:', e.message));
    return;
  }

  // /pause — pause watchdog nudges for this session
  if (msg.text && /^\/pause(@\S+)?$/i.test(msg.text.trim())) {
    handlePauseCommand(threadId, msg.message_id).catch(e => console.error('[pause] error:', e.message));
    return;
  }

  // /resume — resume watchdog nudges for this session
  if (msg.text && /^\/resume(@\S+)?$/i.test(msg.text.trim())) {
    handleResumeCommand(threadId, msg.message_id).catch(e => console.error('[resume] error:', e.message));
    return;
  }

  // /restart — restart the session container
  if (msg.text && /^\/restart(@\S+)?$/i.test(msg.text.trim())) {
    handleRestartCommand(threadId, msg.message_id).catch(e => console.error('[restart] error:', e.message));
    return;
  }

  // /ask [session] [question] — send a question to another session
  const askCmd = msg.text && msg.text.trim().match(/^\/ask(@\S+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (askCmd) {
    handleAskCommand(threadId, msg.message_id, askCmd[2], askCmd[3]).catch(e => console.error('[ask] error:', e.message));
    return;
  }

  // /pin — pin a replied-to message to the knowledge base
  if (msg.text && /^\/pin(@\S+)?$/i.test(msg.text.trim())) {
    handlePinCommand(threadId, msg.message_id, msg.reply_to_message).catch(e => console.error('[pin] error:', e.message));
    return;
  }

  // /report — daily summary
  if (msg.text && /^\/report(@\S+)?$/i.test(msg.text.trim())) {
    handleReportCommand(threadId, msg.message_id).catch(e => console.error('[report] error:', e.message));
    return;
  }

  // /pr [owner/repo] — list open PRs via GitHub CLI
  const prCmd = msg.text && msg.text.trim().match(/^\/pr(@\S+)?(\s+(\S+))?$/i);
  if (prCmd) {
    handlePRCommand(threadId, prCmd[3] || null, msg.message_id).catch(e => console.error('[pr] error:', e.message));
    return;
  }

  // /issues [owner/repo] — list open issues via GitHub CLI
  const issuesCmd = msg.text && msg.text.trim().match(/^\/issues(@\S+)?(\s+(\S+))?$/i);
  if (issuesCmd) {
    handleIssuesCommand(threadId, issuesCmd[3] || null, msg.message_id).catch(e => console.error('[issues] error:', e.message));
    return;
  }

  // /deploy [service] — docker compose restart [service]
  const deployCmd = msg.text && msg.text.trim().match(/^\/deploy(@\S+)?(\s+(\S+))?$/i);
  if (deployCmd) {
    handleDeployCommand(threadId, deployCmd[3] || null, msg.message_id).catch(e => console.error('[deploy] error:', e.message));
    return;
  }

  // /export-config — export sessions.json and schedules.json as formatted message
  if (msg.text && /^\/export-config(@\S+)?$/i.test(msg.text.trim())) {
    handleExportConfigCommand(threadId, msg.message_id).catch(e => console.error('[export-config] error:', e.message));
    return;
  }

  // /rollback [session] — list or rollback Docker image for a session
  const rollbackCmd = msg.text && msg.text.trim().match(/^\/rollback(@\S+)?(\s+(\S+))?$/i);
  if (rollbackCmd) {
    handleRollbackCommand(threadId, msg.message_id, rollbackCmd[3] || null).catch(e => console.error('[rollback] error:', e.message));
    return;
  }

  // /ls [path] — list files in session workdir
  const lsCmd = msg.text && msg.text.trim().match(/^\/ls(@\S+)?(\s+(.+))?$/i);
  if (lsCmd) {
    handleLsCommand(threadId, lsCmd[3] || null, msg.message_id).catch(e => console.error('[ls] error:', e.message));
    return;
  }

  // /cat [filepath] — show first 50 lines of a file
  const catCmd = msg.text && msg.text.trim().match(/^\/cat(@\S+)?\s+(.+)$/i);
  if (catCmd) {
    handleCatCommand(threadId, catCmd[2] || null, msg.message_id).catch(e => console.error('[cat] error:', e.message));
    return;
  }

  // /screenshot [session] — capture tmux pane as text
  const screenshotCmd = msg.text && msg.text.trim().match(/^\/screenshot(@\S+)?(\s+(\S+))?$/i);
  if (screenshotCmd) {
    handleScreenshotCommand(threadId, screenshotCmd[3] || null, msg.message_id).catch(e => console.error('[screenshot] error:', e.message));
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

  // Rate limiting: 30 messages per minute per user
  if (msg.from && msg.from.id && !checkRateLimit(msg.from.id)) {
    console.log(`[rate-limit] User ${msg.from.id} exceeded rate limit in thread ${threadId}`);
    tgSendMessage(threadId, '⏳ יותר מדי הודעות — נסה שוב בעוד דקה', msg.message_id, null).catch(() => {});
    return;
  }

  // Multi-tenant: if session has multi_tenant=true, route per user_id to isolated thread
  const effectiveThreadId = resolveMultiTenantThread(threadId, msg.from.id, msg.from.first_name || msg.from.username || 'user');

  const userId = msg.from && msg.from.id ? String(msg.from.id) : null;
  const userName = (msg.from && (msg.from.first_name || msg.from.username)) || 'unknown';
  const baseEntry = {
    message_id: msg.message_id,
    user: userName,
    user_id: msg.from ? msg.from.id : 0,
    text: msg.text,
    ts: Math.floor(Date.now() / 1000),
    via: 'webhook'
  };

  // Merge buffer: coalesce rapid sequential messages from same user (flood control)
  // Waits MERGE_DELAY_MS for silence before writing to queue, merging any interim messages.
  function flushMergeBuffer(uid) {
    const buf = _mergeBuffer.get(uid);
    if (!buf) return;
    _mergeBuffer.delete(uid);
    const merged = { ...buf.firstEntry, text: buf.messages.join('\n') };
    const queueFile = path.join(QUEUE_DIR, `tg-queue-${buf.effectiveThreadId}.jsonl`);
    try {
      fs.appendFileSync(queueFile, JSON.stringify(merged) + '\n');
      fs.writeFileSync(path.join(QUEUE_DIR, `relay-msg-start-${buf.effectiveThreadId}`), String(Date.now()));
      const label = buf.messages.length > 1 ? `[merged ${buf.messages.length} msgs] ` : '';
      console.log(`[webhook] ${buf.effectiveThreadId}: ${buf.firstEntry.user}: ${label}${merged.text.substring(0, 60)}`);
    } catch (err) { console.error(`[webhook] Queue write error:`, err.message); }
  }

  if (userId) {
    const existing = _mergeBuffer.get(userId);
    if (existing) {
      // Cancel previous timer, append text, restart timer
      clearTimeout(existing.timer);
      existing.messages.push(msg.text);
      existing.timer = setTimeout(() => flushMergeBuffer(userId), MERGE_DELAY_MS);
    } else {
      // Start new buffer entry for this user
      const bufEntry = {
        timer: null,
        messages: [msg.text],
        firstEntry: baseEntry,
        effectiveThreadId,
      };
      bufEntry.timer = setTimeout(() => flushMergeBuffer(userId), MERGE_DELAY_MS);
      _mergeBuffer.set(userId, bufEntry);
    }
  } else {
    // No userId — write directly (shouldn't normally happen)
    const queueFile = path.join(QUEUE_DIR, `tg-queue-${effectiveThreadId}.jsonl`);
    try {
      fs.appendFileSync(queueFile, JSON.stringify(baseEntry) + '\n');
      fs.writeFileSync(path.join(QUEUE_DIR, `relay-msg-start-${effectiveThreadId}`), String(Date.now()));
      console.log(`[webhook] ${effectiveThreadId}: ${userName}: ${msg.text.substring(0, 60)}`);
    } catch (err) {
      console.error(`[webhook] Queue write error:`, err.message);
    }
  }

  // Mention routing: if message contains @session_name, copy to that session's queue
  try {
    const mentionMatches = msg.text.match(/@([a-zA-Z0-9_-]+)/g);
    if (mentionMatches) {
      const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const mention of mentionMatches) {
        const mentionName = mention.slice(1); // strip '@'
        const targetSession = sessions.find(s =>
          s.session === mentionName || s.name === mentionName
        );
        if (!targetSession || String(targetSession.thread_id) === String(effectiveThreadId)) continue;
        const targetQueue = path.join(QUEUE_DIR, `tg-queue-${targetSession.thread_id}.jsonl`);
        const mentionEntry = {
          ...baseEntry,
          message_id: -(Math.floor(Date.now() / 1000) % 2147483647),
          via: 'mention',
          force: true,
          mention_from_thread: effectiveThreadId,
        };
        fs.appendFileSync(targetQueue, JSON.stringify(mentionEntry) + '\n');
        console.log(`[mention] Routed @${mentionName} → thread ${targetSession.thread_id}`);
      }
    }
  } catch (e) {
    console.error('[mention] Routing error:', e.message);
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

// /cancel command — send SIGINT to Claude process in the session container
async function handleCancelCommand(threadId, replyTo) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => String(s.thread_id) === String(threadId));
    if (!session) {
      await tgSendMessage(threadId, `❌ לא נמצא session ל-thread ${threadId}`, replyTo, null);
      return;
    }
    const containerName = `relay-session-${session.session}`;
    try {
      execSync(`docker exec ${containerName} pkill -INT -f "claude" 2>/dev/null || true`, { timeout: 5000 });
      await tgSendMessage(threadId, `⏹ נשלח SIGINT ל-Claude ב-<code>${session.session}</code>`, replyTo, null);
      console.log(`[cancel] Sent SIGINT to claude in ${containerName}`);
    } catch (e) {
      await tgSendMessage(threadId, `⚠️ שגיאה בשליחת SIGINT: ${e.message}`, replyTo, null);
    }
  } catch (e) {
    console.error('[cancel] Failed:', e.message);
  }
}

// /pause command — write flag file to pause watchdog nudges for this session
async function handlePauseCommand(threadId, replyTo) {
  try {
    const flagFile = `/tmp/relay-paused-${threadId}`;
    fs.writeFileSync(flagFile, String(Date.now()));
    await tgSendMessage(threadId, `⏸ Session paused — Claude will not be nudged.\nSend /resume to re-enable.`, replyTo, null);
    console.log(`[pause] Thread ${threadId} paused`);
  } catch (e) {
    console.error('[pause] Failed:', e.message);
  }
}

// /resume command — remove pause flag file
async function handleResumeCommand(threadId, replyTo) {
  try {
    const flagFile = `/tmp/relay-paused-${threadId}`;
    if (fs.existsSync(flagFile)) {
      fs.unlinkSync(flagFile);
      await tgSendMessage(threadId, `▶️ Session resumed — watchdog nudges re-enabled.`, replyTo, null);
      console.log(`[resume] Thread ${threadId} resumed`);
    } else {
      await tgSendMessage(threadId, `▶️ Session was not paused — already active.`, replyTo, null);
    }
  } catch (e) {
    console.error('[resume] Failed:', e.message);
  }
}

// /restart command — restart the session container
async function handleRestartCommand(threadId, replyTo) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => String(s.thread_id) === String(threadId));
    if (!session) {
      await tgSendMessage(threadId, `❌ לא נמצא session ל-thread ${threadId}`, replyTo, null);
      return;
    }
    const containerName = `relay-session-${session.session}`;
    await tgSendMessage(threadId, `🔄 מפעיל מחדש את <code>${session.session}</code>...`, replyTo, null);
    try {
      execSync(`docker restart ${containerName}`, { timeout: 30000 });
      await tgSendMessage(threadId, `✅ Container <code>${session.session}</code> הופעל מחדש`, null, null);
      console.log(`[restart] Restarted container ${containerName}`);
    } catch (e) {
      await tgSendMessage(threadId, `⚠️ שגיאה בהפעלה מחדש: ${e.message}`, null, null);
    }
  } catch (e) {
    console.error('[restart] Failed:', e.message);
  }
}

// /ask [session] [question] — forward a question to another session's queue
async function handleAskCommand(fromThreadId, replyTo, targetSession, question) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const target = sessions.find(s => s.session === targetSession);
    if (!target) {
      await tgSendMessage(fromThreadId, `❌ Session <code>${targetSession}</code> לא נמצא`, replyTo, null);
      return;
    }
    const queueFile = path.join(QUEUE_DIR, `tg-queue-${target.thread_id}.jsonl`);
    const entry = {
      message_id: -(Math.floor(Date.now() / 1000) % 2147483647),
      user: `ask:thread-${fromThreadId}`,
      text: question,
      ts: Math.floor(Date.now() / 1000),
      via: 'ask',
      force: true,
    };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    await tgSendMessage(fromThreadId, `📨 שאלה נשלחה ל-<code>${targetSession}</code>`, replyTo, null);
    console.log(`[ask] thread ${fromThreadId} → ${targetSession}: ${question.substring(0, 60)}`);
  } catch (e) {
    console.error('[ask] Failed:', e.message);
    await tgSendMessage(fromThreadId, `❌ שגיאה בשליחת שאלה: ${e.message}`, replyTo, null);
  }
}

// /pin — save replied-to message to per-thread knowledge base
async function handlePinCommand(threadId, replyTo, replyToMsg) {
  try {
    if (!replyToMsg) {
      await tgSendMessage(threadId, '📌 השתמש ב-/pin כ-reply להודעה שרוצה לשמור', replyTo, null);
      return;
    }
    // Extract text from the replied-to message
    const text = replyToMsg.text || replyToMsg.caption || JSON.stringify(replyToMsg);
    const knowledgeFile = path.join(QUEUE_DIR, `relay-knowledge-${threadId}.jsonl`);
    const entry = {
      ts: Math.floor(Date.now() / 1000),
      message_id: replyToMsg.message_id,
      user: replyToMsg.from ? (replyToMsg.from.first_name || replyToMsg.from.username || 'unknown') : 'unknown',
      text,
      pinned_by_msg: replyTo,
    };
    fs.appendFileSync(knowledgeFile, JSON.stringify(entry) + '\n');
    await tgSendMessage(threadId, '📌 נשמר ב-knowledge base', replyTo, null);
    console.log(`[pin] thread ${threadId}: pinned message ${replyToMsg.message_id}`);
  } catch (e) {
    console.error('[pin] Failed:', e.message);
    await tgSendMessage(threadId, `❌ שגיאה בשמירה: ${e.message}`, replyTo, null);
  }
}

// /report — daily summary of activity
async function handleReportCommand(threadId, replyTo) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const queueFile = path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
    const statsFile = path.join(QUEUE_DIR, `token-stats-${threadId}.jsonl`);
    const auditFile = path.join(QUEUE_DIR, `relay-audit-${threadId}.jsonl`);

    let userMsgs = 0, claudeMsgs = 0, toolCalls = 0;
    let totalInput = 0, totalOutput = 0, totalCost = 0;

    // Count messages from queue
    if (fs.existsSync(queueFile)) {
      const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          const msgDate = m.ts ? new Date(m.ts * 1000).toISOString().slice(0, 10) : '';
          if (msgDate !== today) continue;
          if (m.via === 'claude' || m.user === 'claude') claudeMsgs++;
          else if (m.via === 'webhook' || m.via === 'reaction' || m.via === 'callback') userMsgs++;
        } catch (_) {}
      }
    }

    // Count tool calls from audit log
    if (fs.existsSync(auditFile)) {
      const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          const eDate = e.ts ? new Date(e.ts * 1000).toISOString().slice(0, 10) : (e.timestamp || '').slice(0, 10);
          if (eDate !== today) continue;
          if (e.type === 'tool_use' || e.event === 'tool_use') toolCalls++;
        } catch (_) {}
      }
    }

    // Token stats for today
    if (fs.existsSync(statsFile)) {
      const lines = fs.readFileSync(statsFile, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (!(e.ts || '').startsWith(today)) continue;
          totalInput += e.input || 0;
          totalOutput += e.output || 0;
          totalCost += e.cost_usd || 0;
        } catch (_) {}
      }
    }

    const fmt = n => n.toLocaleString('en-US');
    const text = [
      `📊 <b>דוח יומי — ${today}</b>`,
      '',
      `💬 הודעות: ${userMsgs} (משתמש) + ${claudeMsgs} (Claude)`,
      `🔧 קריאות כלים: ${toolCalls}`,
      `🪙 טוקנים: ${fmt(totalInput)} (in) + ${fmt(totalOutput)} (out)`,
      `💰 עלות: $${totalCost.toFixed(4)}`,
    ].join('\n');

    await tgSendMessage(threadId, text, replyTo, null);
    console.log(`[report] Generated daily report for thread ${threadId}`);
  } catch (e) {
    console.error('[report] Failed:', e.message);
    await tgSendMessage(threadId, `❌ שגיאה בהפקת דוח: ${e.message}`, replyTo, null);
  }
}

// /pr [owner/repo] — list open PRs via GitHub CLI
async function handlePRCommand(threadId, repo, replyTo) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) {
    await tgSendMessage(threadId, '⚠️ GH_TOKEN לא מוגדר', replyTo, null);
    return;
  }
  try {
    const repoArg = repo ? `--repo ${repo}` : '';
    const out = execSync(
      `gh pr list ${repoArg} --json number,title,state,author --limit 5`,
      { timeout: 15000, env: { ...process.env, GH_TOKEN: ghToken } }
    ).toString();
    const prs = JSON.parse(out);
    if (!prs.length) {
      await tgSendMessage(threadId, `📋 אין PRs פתוחים${repo ? ' ב-' + repo : ''}`, replyTo, null);
      return;
    }
    const lines = [`📋 <b>Open PRs${repo ? ' — ' + repo : ''}</b>`, ''];
    for (const pr of prs) {
      lines.push(`• #${pr.number} <b>${pr.title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</b> (${pr.author?.login || 'unknown'})`);
    }
    await tgSendMessage(threadId, lines.join('\n'), replyTo, null);
  } catch (e) {
    await tgSendMessage(threadId, `❌ שגיאה ב-/pr: ${e.message.substring(0, 200)}`, replyTo, null);
  }
}

// /issues [owner/repo] — list open issues via GitHub CLI
async function handleIssuesCommand(threadId, repo, replyTo) {
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) {
    await tgSendMessage(threadId, '⚠️ GH_TOKEN לא מוגדר', replyTo, null);
    return;
  }
  try {
    const repoArg = repo ? `--repo ${repo}` : '';
    const out = execSync(
      `gh issue list ${repoArg} --json number,title,state,author --limit 5`,
      { timeout: 15000, env: { ...process.env, GH_TOKEN: ghToken } }
    ).toString();
    const issues = JSON.parse(out);
    if (!issues.length) {
      await tgSendMessage(threadId, `🐛 אין issues פתוחים${repo ? ' ב-' + repo : ''}`, replyTo, null);
      return;
    }
    const lines = [`🐛 <b>Open Issues${repo ? ' — ' + repo : ''}</b>`, ''];
    for (const issue of issues) {
      lines.push(`• #${issue.number} <b>${issue.title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</b> (${issue.author?.login || 'unknown'})`);
    }
    await tgSendMessage(threadId, lines.join('\n'), replyTo, null);
  } catch (e) {
    await tgSendMessage(threadId, `❌ שגיאה ב-/issues: ${e.message.substring(0, 200)}`, replyTo, null);
  }
}

// /deploy [service] — docker compose restart [service] or list services
async function handleDeployCommand(threadId, service, replyTo) {
  try {
    if (!service) {
      // List running containers
      const out = execSync(
        `docker ps --format '{{.Names}}' 2>/dev/null | grep -v relay-api || true`,
        { timeout: 10000 }
      ).toString().trim();
      const names = out ? out.split('\n').map(n => n.trim()).filter(Boolean) : [];
      if (!names.length) {
        await tgSendMessage(threadId, '🐳 אין containers פעילים', replyTo, null);
        return;
      }
      const btns = names.slice(0, 6).map(n => ({ text: n, callback_data: `btn:${threadId}:/deploy ${n}` }));
      await tgSendMessage(threadId, `🐳 <b>בחר שירות ל-restart:</b>\n${names.join('\n')}`, replyTo,
        btns.length ? { inline_keyboard: [btns] } : null);
      return;
    }
    // Sanitize
    const svc = service.replace(/[^a-zA-Z0-9_-]/g, '');
    await tgSendMessage(threadId, `🔄 מפעיל מחדש <code>${svc}</code>...`, replyTo, null);
    const out = execSync(`docker restart ${svc}`, { timeout: 30000 }).toString().trim();
    await tgSendMessage(threadId, `✅ <code>${svc}</code> הופעל מחדש${out ? '\n<code>' + out.substring(0, 100) + '</code>' : ''}`, null, null);
  } catch (e) {
    await tgSendMessage(threadId, `❌ שגיאה ב-/deploy: ${e.message.substring(0, 200)}`, replyTo, null);
  }
}

// /ls [path] — list files in session workdir
async function handleLsCommand(threadId, lsPath, replyTo) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => String(s.thread_id) === String(threadId));
    const workdir = session ? (session.path || '/root') : '/root';
    const targetPath = lsPath ? lsPath.trim() : workdir;
    // Basic path safety — no shell injection
    const safePath = targetPath.replace(/[`$;|&<>]/g, '');
    const out = execSync(`ls -la ${safePath}`, { timeout: 5000 }).toString();
    const truncated = out.length > 3000 ? out.slice(0, 3000) + '\n… (truncated)' : out;
    await tgSendMessage(threadId, `<pre>${truncated.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`, replyTo, null);
  } catch (e) {
    await tgSendMessage(threadId, `❌ שגיאה ב-/ls: ${e.message.substring(0, 200)}`, replyTo, null);
  }
}

// /cat [filepath] — show first 50 lines of a file
async function handleCatCommand(threadId, filePath, replyTo) {
  if (!filePath) {
    await tgSendMessage(threadId, '❌ שימוש: /cat [filepath]', replyTo, null);
    return;
  }
  try {
    // Basic safety check — no shell injection
    const safePath = filePath.trim().replace(/[`$;|&<>]/g, '');
    const out = execSync(`head -50 ${safePath}`, { timeout: 5000 }).toString();
    const truncated = out.length > 3000 ? out.slice(0, 3000) + '\n… (truncated)' : out;
    await tgSendMessage(threadId, `<pre>${truncated.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`, replyTo, null);
  } catch (e) {
    await tgSendMessage(threadId, `❌ שגיאה ב-/cat: ${e.message.substring(0, 200)}`, replyTo, null);
  }
}

// /screenshot [session] — capture tmux pane as text and send to Telegram
async function handleScreenshotCommand(threadId, args, replyTo) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    let session;
    if (args && args.trim()) {
      // Find by name/session arg
      const name = args.trim();
      session = sessions.find(s => s.session === name || s.name === name);
      if (!session) {
        await tgSendMessage(threadId, `❌ Session לא נמצא: <code>${name}</code>`, replyTo, null);
        return;
      }
    } else {
      // Find by thread_id
      session = sessions.find(s => String(s.thread_id) === String(threadId));
      if (!session) {
        await tgSendMessage(threadId, `❌ לא נמצא session ל-thread ${threadId}`, replyTo, null);
        return;
      }
    }
    const name = session.session || session.name;
    const containerName = `relay-session-${name}`;
    const socketPath = `/tmp/tmux-relay-${name}.sock`;
    const destFile = `/tmp/relay-pane-${threadId}.txt`;

    // Capture pane inside container, then docker cp out
    try {
      execSync(
        `docker exec ${containerName} bash -c "tmux -S ${socketPath} capture-pane -p -t ${name} > /tmp/pane.txt 2>/dev/null; cat /tmp/pane.txt"`,
        { timeout: 8000 }
      );
      execSync(`docker cp ${containerName}:/tmp/pane.txt ${destFile}`, { timeout: 5000 });
    } catch (e) {
      // Fallback: try running tmux capture directly on host socket if mounted
      await tgSendMessage(threadId, `❌ שגיאה בלכידת pane: ${e.message.substring(0, 200)}`, replyTo, null);
      return;
    }

    let paneText = '';
    try {
      paneText = fs.readFileSync(destFile, 'utf8');
    } catch (_) {
      await tgSendMessage(threadId, '❌ לא ניתן לקרוא את תוצאת ה-capture', replyTo, null);
      return;
    }

    // Clean ANSI escape codes
    paneText = paneText
      .replace(/\x1b\[[0-9;]*[mGKHFABCDJP]/g, '')
      .replace(/\r/g, '')
      .trimEnd();

    if (!paneText.trim()) {
      await tgSendMessage(threadId, `📸 Pane ריק (session: <code>${name}</code>)`, replyTo, null);
      return;
    }

    // Truncate to safe Telegram message size
    const truncated = paneText.length > 3500 ? paneText.slice(-3500) + '\n… (truncated)' : paneText;
    const escaped = truncated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await tgSendMessage(threadId, `📸 <b>${name}</b>\n<pre>${escaped}</pre>`, replyTo, null);
  } catch (e) {
    await tgSendMessage(threadId, `❌ שגיאה ב-/screenshot: ${e.message.substring(0, 200)}`, replyTo, null);
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

// /export-config — send sessions.json content as a formatted message (schedules truncated)
async function handleExportConfigCommand(threadId, replyTo) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    // Redact sensitive fields
    const safe = sessions.map(s => {
      const { bot_token, ...rest } = s;
      return rest;
    });
    const sessionsText = JSON.stringify(safe, null, 2);

    const SCHEDULES_FILE = process.env.SCHEDULES_FILE || '/relay/schedules.json';
    let schedulesText = '';
    try {
      const schedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
      schedulesText = JSON.stringify(schedules, null, 2);
    } catch (_) { schedulesText = '[]'; }

    const MAX = 3000;
    const header = `📦 <b>Config Export</b>\n\n<b>sessions.json</b> (${safe.length} sessions):\n`;
    const truncated = sessionsText.length > MAX ? sessionsText.slice(0, MAX) + '\n…(truncated)' : sessionsText;
    await tgSendMessage(threadId, header + `<pre>${truncated.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`, replyTo, null);

    if (schedulesText.length < MAX) {
      const schedsHeader = `<b>schedules.json</b>:\n`;
      await tgSendMessage(threadId, schedsHeader + `<pre>${schedulesText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`, null, null);
    }
    console.log(`[export-config] Exported config to thread ${threadId}`);
  } catch (e) {
    console.error('[export-config] Failed:', e.message);
    await tgSendMessage(threadId, `❌ שגיאה ב-export-config: ${e.message}`, replyTo, null);
  }
}

// /rollback [session] — list recent Docker image IDs or rollback a session image
async function handleRollbackCommand(threadId, replyTo, sessionArg) {
  try {
    if (!sessionArg) {
      // List recent relay-session image history
      let out;
      try {
        out = execSync(`docker image ls relay-session --format '{{json .}}' 2>/dev/null`, { timeout: 10000 }).toString().trim();
      } catch (_) { out = ''; }

      if (!out) {
        await tgSendMessage(threadId, '🐳 לא נמצאו images של <code>relay-session</code>', replyTo, null);
        return;
      }

      const images = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const lines = ['🐳 <b>relay-session images:</b>', ''];
      for (const img of images.slice(0, 8)) {
        lines.push(`• <code>${img.Tag || 'none'}</code> — ${img.ID || ''} (${img.CreatedSince || img.CreatedAt || ''})`);
      }
      lines.push('', 'שימוש: <code>/rollback &lt;session&gt;</code> לשחזור');
      await tgSendMessage(threadId, lines.join('\n'), replyTo, null);
      return;
    }

    // Rollback a specific session — tag :previous as :latest and restart container
    const safeSession = sessionArg.replace(/[^a-zA-Z0-9_-]/g, '');
    const containerName = `relay-session-${safeSession}`;

    // Check if :previous tag exists
    let prevExists = false;
    try {
      const check = execSync(`docker image inspect relay-session:previous 2>/dev/null || echo "notfound"`, { timeout: 5000 }).toString();
      prevExists = !check.includes('notfound') && check.trim() !== '';
    } catch (_) {}

    if (!prevExists) {
      await tgSendMessage(threadId, `⚠️ אין image בתג <code>relay-session:previous</code> לשחזור`, replyTo, null);
      return;
    }

    await tgSendMessage(threadId, `🔄 משחזר <code>${safeSession}</code> ל-image הקודם...`, replyTo, null);

    try {
      execSync(`docker tag relay-session:previous relay-session:latest`, { timeout: 10000 });
      execSync(`docker restart ${containerName}`, { timeout: 30000 });
      await tgSendMessage(threadId, `✅ Rollback הושלם עבור <code>${safeSession}</code>`, null, null);
      console.log(`[rollback] Rolled back ${containerName} to previous image`);
    } catch (e) {
      await tgSendMessage(threadId, `❌ שגיאה ב-rollback: ${e.message.substring(0, 200)}`, null, null);
    }
  } catch (e) {
    console.error('[rollback] Failed:', e.message);
    await tgSendMessage(threadId, `❌ שגיאה ב-rollback: ${e.message}`, replyTo, null);
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
console.log(`[webhooks] GitHub inbound: POST /webhooks/github (HMAC-SHA256 via GITHUB_WEBHOOK_SECRET)`);
console.log(`[webhooks] Generic inbound: POST /webhooks/generic (Bearer WEBHOOK_TOKEN)`);
if (ALLOW_SELF_REGISTER) console.log(`[self-register] ALLOW_SELF_REGISTER=true — new threads will be auto-provisioned`);

// ── Feature 1: GitHub Webhook ─────────────────────────────────────────────────
// POST /webhooks/github — receives GitHub events and routes to matching session
// Secured by HMAC-SHA256 signature (X-Hub-Signature-256 header)
app.post('/webhooks/github', express.raw({ type: 'application/json' }), (req, res) => {
  const crypto = require('crypto');
  res.json({ ok: true });

  // Verify HMAC-SHA256 signature
  const sigHeader = req.headers['x-hub-signature-256'] || '';
  if (GITHUB_WEBHOOK_SECRET) {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');
    if (sigHeader !== expected) {
      console.warn('[github-webhook] Invalid signature — ignoring');
      return;
    }
  }

  let payload;
  try { payload = JSON.parse(req.body.toString()); } catch (e) {
    console.error('[github-webhook] JSON parse error:', e.message);
    return;
  }

  const event = req.headers['x-github-event'] || 'unknown';
  const repo = (payload.repository && payload.repository.full_name) || '';
  console.log(`[github-webhook] event=${event} repo=${repo}`);

  // Find matching session by github_repo field, fall back to default thread
  let threadId = GITHUB_DEFAULT_THREAD_ID || null;
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const match = sessions.find(s => s.github_repo && s.github_repo === repo);
    if (match) threadId = String(match.thread_id);
  } catch (_) {}

  if (!threadId) {
    console.warn('[github-webhook] No matching session and no GITHUB_DEFAULT_THREAD_ID set — dropping');
    return;
  }

  // Format message by event type
  let text = '';
  if (event === 'pull_request') {
    const pr = payload.pull_request || {};
    const action = payload.action || '';
    const merged = pr.merged ? ' (merged)' : '';
    const stateLabel = action === 'closed' ? (pr.merged ? 'merged' : 'closed') : action;
    text = `🔀 <b>PR ${stateLabel}${merged}</b> [${repo}]\n` +
      `<b>#${pr.number}</b> ${pr.title}\n` +
      `by ${pr.user && pr.user.login} — <code>${pr.head && pr.head.ref}</code> → <code>${pr.base && pr.base.ref}</code>\n` +
      (pr.html_url ? `<code>${pr.html_url}</code>` : '');
  } else if (event === 'push') {
    const commits = payload.commits || [];
    const branch = (payload.ref || '').replace('refs/heads/', '');
    const pusher = payload.pusher && payload.pusher.name;
    const lines = commits.slice(0, 5).map(c =>
      `• <code>${c.id.slice(0, 7)}</code> ${(c.message || '').split('\n')[0].slice(0, 80)}`
    );
    text = `📦 <b>Push</b> [${repo}] → <code>${branch}</code> by ${pusher}\n` +
      lines.join('\n') +
      (commits.length > 5 ? `\n… and ${commits.length - 5} more` : '');
  } else if (event === 'issues') {
    const issue = payload.issue || {};
    const action = payload.action || '';
    const stateEmoji = action === 'opened' ? '🐛' : action === 'closed' ? '✅' : '📝';
    text = `${stateEmoji} <b>Issue ${action}</b> [${repo}]\n` +
      `<b>#${issue.number}</b> ${issue.title}\n` +
      `by ${issue.user && issue.user.login}\n` +
      (issue.html_url ? `<code>${issue.html_url}</code>` : '');
  } else if (event === 'workflow_run') {
    const run = payload.workflow_run || {};
    const wf = payload.workflow || {};
    const conclusion = run.conclusion || run.status || 'unknown';
    const emoji = conclusion === 'success' ? '✅' : conclusion === 'failure' ? '❌' : '⚙️';
    text = `${emoji} <b>CI ${conclusion}</b> [${repo}]\n` +
      `Workflow: ${wf.name || run.name}\n` +
      `Branch: <code>${run.head_branch}</code>\n` +
      (run.html_url ? `<code>${run.html_url}</code>` : '');
  } else {
    // Generic fallback for other events
    text = `🔔 <b>GitHub event: ${event}</b> [${repo}]`;
  }

  if (!text) return;

  const entry = {
    message_id: -(Math.floor(Date.now() / 1000) % 2147483647),
    user: `github:${event}`,
    text,
    ts: Math.floor(Date.now() / 1000),
    via: 'github',
    force: true,
  };
  try {
    fs.appendFileSync(path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`), JSON.stringify(entry) + '\n');
    console.log(`[github-webhook] Queued ${event} to thread ${threadId}`);
  } catch (e) {
    console.error('[github-webhook] Queue error:', e.message);
  }
});

// ── Feature 2: Generic Webhook (n8n / Zapier / Make / PagerDuty / Sentry) ─────
// POST /webhooks/generic — accepts JSON with thread_id/session + text
// Secured by Authorization: Bearer WEBHOOK_TOKEN header
app.post('/webhooks/generic', (req, res) => {
  if (!WEBHOOK_TOKEN) {
    return res.status(403).json({ ok: false, error: 'WEBHOOK_TOKEN not configured' });
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { thread_id, session, text, via } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  // Resolve thread_id from session name if given
  let threadId = thread_id ? String(thread_id) : null;
  if (!threadId && session) {
    try {
      const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const match = sessions.find(s => s.session === session || s.name === session);
      if (match) threadId = String(match.thread_id);
    } catch (_) {}
  }
  if (!threadId) return res.status(400).json({ ok: false, error: 'thread_id or valid session required' });

  const entry = {
    message_id: -(Math.floor(Date.now() / 1000) % 2147483647),
    user: `webhook:${via || 'generic'}`,
    text: String(text).slice(0, 4000),
    ts: Math.floor(Date.now() / 1000),
    via: via || 'webhook',
    force: true,
  };
  try {
    fs.appendFileSync(path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`), JSON.stringify(entry) + '\n');
    console.log(`[generic-webhook] Queued message to thread ${threadId} via ${via || 'generic'}`);
    return res.json({ ok: true, queued: true });
  } catch (e) {
    console.error('[generic-webhook] Queue error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

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

// --- Token usage graph ---
// GET /api/token-graph/:session — daily aggregated token usage for a session
app.get('/api/token-graph/:session', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sessionName = req.params.session.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === sessionName);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const threadId = session.thread_id;
    const statsFile = path.join(QUEUE_DIR, `token-stats-${threadId}.jsonl`);
    if (!fs.existsSync(statsFile)) return res.json([]);

    const lines = fs.readFileSync(statsFile, 'utf8').split('\n').filter(l => l.trim());
    const byDate = {};
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        const date = (e.ts || '').slice(0, 10);
        if (!date) continue;
        if (!byDate[date]) byDate[date] = { date, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        byDate[date].input_tokens  += e.input  || 0;
        byDate[date].output_tokens += e.output || 0;
        byDate[date].cost_usd      += e.cost_usd || 0;
      } catch (_) {}
    }
    const result = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Sessions graph (dependency/peer graph for orchestrator) ---
app.get('/api/sessions/graph', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const nodes = sessions.map(s => {
      const node = {
        session:      s.session,
        thread_id:    s.thread_id,
        host:         s.host || null,
        path:         s.path || null,
        type:         s.type || 'claude',
        skills:       s.skills || [],
        group:        s.group || '',
        orchestrator: !!s.orchestrator,
      };

      // Check last activity
      const lastSentFile = `/tmp/tg-last-sent-${s.thread_id}`;
      try {
        const ts = parseFloat(fs.readFileSync(lastSentFile, 'utf8').trim());
        node.last_active = isNaN(ts) ? null : ts;
      } catch { node.last_active = null; }

      // Read recent peer-to-peer queue entries to find edges
      const queueFile = path.join(QUEUE_DIR, `tg-queue-${s.thread_id}.jsonl`);
      const recentPeers = new Set();
      try {
        const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(l => l.trim());
        for (const line of lines.slice(-100)) {
          try {
            const m = JSON.parse(line);
            if (m.user && m.user.startsWith('peer:')) {
              recentPeers.add(m.user.slice(5));
            }
            if (m.user && m.user.startsWith('agent:')) {
              recentPeers.add(m.user.slice(6));
            }
          } catch (_) {}
        }
      } catch (_) {}
      node.recent_peers = Array.from(recentPeers);

      return node;
    });
    res.json(nodes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Knowledge base endpoint ---
// GET /api/knowledge/:session — returns pinned knowledge entries for a session
app.get('/api/knowledge/:session', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === req.params.session);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const knowledgeFile = path.join(QUEUE_DIR, `relay-knowledge-${session.thread_id}.jsonl`);
    if (!fs.existsSync(knowledgeFile)) return res.json([]);
    const entries = fs.readFileSync(knowledgeFile, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
    res.json(entries);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Audit log endpoint ---
// GET /api/audit/:session — returns last 50 audit log entries for a session
app.get('/api/audit/:session', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === req.params.session);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const threadId = session.thread_id;
    const auditFile = `/tmp/relay-audit-${threadId}.jsonl`;
    if (!fs.existsSync(auditFile)) return res.json([]);
    const lines = fs.readFileSync(auditFile, 'utf8')
      .split('\n')
      .filter(l => l.trim());
    const last50 = lines.slice(-50);
    const entries = last50.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    res.json(entries);
  } catch (e) {
    console.error('[audit] Failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Health Check Endpoints ───────────────────────────────────────────────────
// GET /health — no auth required, used by external uptime monitors
// Returns overall status + per-session last_seen info
const STALE_THRESHOLD_SEC = 30 * 60; // 30 minutes

function buildSessionHealthData() {
  const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const sessionData = [];

  for (const s of sessions) {
    if (s.host) continue; // skip remote sessions
    const lastSentFile = `/tmp/tg-last-sent-${s.thread_id}`;
    let lastSeen = null;
    let status = 'unknown';

    try {
      const raw = fs.readFileSync(lastSentFile, 'utf8').trim();
      lastSeen = parseInt(raw);
      if (isNaN(lastSeen)) lastSeen = null;
    } catch (_) {}

    if (lastSeen !== null) {
      const age = now - lastSeen;
      status = age > STALE_THRESHOLD_SEC ? 'degraded' : 'running';
    } else {
      // Fallback: check container state
      try {
        const state = execSync(
          `docker inspect --format '{{.State.Status}}' relay-session-${s.session} 2>/dev/null`,
          { timeout: 3000 }
        ).toString().trim();
        status = state === 'running' ? 'running' : 'degraded';
      } catch (_) {
        status = 'degraded';
      }
    }

    sessionData.push({
      name: s.session,
      thread_id: s.thread_id,
      status,
      last_seen: lastSeen,
    });
  }

  return sessionData;
}

app.get('/health', (req, res) => {
  try {
    const sessions = buildSessionHealthData();
    const allOk = sessions.every(s => s.status === 'running' || s.status === 'unknown');
    res.json({
      status: allOk ? 'ok' : 'degraded',
      ts: Math.floor(Date.now() / 1000),
      uptime: Math.floor(process.uptime()),
      sessions,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

app.get('/health/sessions', (req, res) => {
  try {
    res.json(buildSessionHealthData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Direct notify API ─────────────────────────────────────────────────────────
// POST /api/notify — send a DM to NOTIFY_USER_ID (used by scripts like backup.sh)
app.post('/api/notify', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const text = req.body && req.body.text ? String(req.body.text) : '';
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!NOTIFY_USER_ID) return res.status(503).json({ error: 'NOTIFY_USER_ID not configured' });
  notifyUser(text, req.body.urgent !== false);
  res.json({ ok: true });
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Telegram Mini App ─────────────────────────────────────────────────────────
// All /miniapp/* routes are public — authenticated via Telegram WebApp initData.

const MINIAPP_HTML = process.env.MINIAPP_HTML || '/relay/miniapp/index.html';

// Validate Telegram WebApp initData (HMAC-SHA256)
function validateInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  try {
    const crypto = require('crypto');
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const dataCheckString = [...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return computedHash === hash;
  } catch (_) { return false; }
}

// GET /miniapp — serve the Mini App HTML
app.get('/miniapp', (req, res) => {
  try {
    res.type('html').send(fs.readFileSync(MINIAPP_HTML, 'utf8'));
  } catch (e) { res.status(500).send('Mini App not found'); }
});

// GET /miniapp/sessions — sessions list with status (no auth, used by Mini App)
app.get('/miniapp/sessions', (req, res) => {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    let metricsMap = {};
    try {
      const metricsRaw = execSync(METRICS_SCRIPT, { timeout: 10000 }).toString();
      const metrics = JSON.parse(metricsRaw);
      for (const m of metrics) metricsMap[m.session] = m.status;
    } catch (_) {}

    const result = sessions.map(s => {
      const lastSentFile = `/tmp/tg-last-sent-${s.thread_id}`;
      let lastActive = null;
      try {
        const ts = parseFloat(fs.readFileSync(lastSentFile, 'utf8').trim());
        if (!isNaN(ts)) lastActive = ts;
      } catch (_) {}
      return {
        session:     s.session,
        thread_id:   s.thread_id,
        group:       s.group || '',
        type:        s.type || 'claude',
        status:      metricsMap[s.session] || 'unknown',
        last_active: lastActive,
      };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /miniapp/history/:session — last 20 messages/events for a session
app.get('/miniapp/history/:session', (req, res) => {
  try {
    const sessionName = req.params.session.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === sessionName);
    if (!session) return res.status(404).json({ error: 'session not found' });

    const events = [];
    const threadId = session.thread_id;

    // Messages from queue file
    const queueFile = `/tmp/tg-queue-${threadId}.jsonl`;
    if (fs.existsSync(queueFile)) {
      const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines.slice(-50)) {
        try {
          const m = JSON.parse(line);
          if (!m.text) continue;
          events.push({
            ts:   m.ts ? new Date(m.ts * 1000).toISOString() : null,
            type: 'message',
            text: (m.text || '').slice(0, 400),
            user: m.user || 'unknown',
          });
        } catch (_) {}
      }
    }

    // Tool calls from Claude project JSONL
    try {
      const projectKey = session.path.replace(/\//g, '-').replace(/[^a-zA-Z0-9._-]/g, '-');
      const projectDir = `/root/.claude/projects/${projectKey}`;
      const latest = fs.existsSync(projectDir)
        ? fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')).sort().pop()
        : null;
      if (latest) {
        const lines = fs.readFileSync(path.join(projectDir, latest), 'utf8').split('\n').filter(l => l.trim());
        for (const line of lines.slice(-100)) {
          try {
            const d = JSON.parse(line);
            if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
              for (const block of d.message.content) {
                if (block.type === 'tool_use') {
                  events.push({
                    ts:      d.timestamp,
                    type:    'tool',
                    tool:    block.name,
                    command: JSON.stringify(block.input || {}).slice(0, 120),
                  });
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    events.sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : 1);
    res.json(events.slice(-20));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /miniapp/stats/:session — token usage for a session
app.get('/miniapp/stats/:session', (req, res) => {
  try {
    const sessionName = req.params.session.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === sessionName);
    if (!session) return res.status(404).json({ error: 'session not found' });

    const statsFile = path.join(QUEUE_DIR, `token-stats-${session.thread_id}.jsonl`);
    if (!fs.existsSync(statsFile)) return res.json({ session: sessionName, daily: [] });

    const lines = fs.readFileSync(statsFile, 'utf8').split('\n').filter(l => l.trim());
    const byDate = {};
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        const date = (e.ts || '').slice(0, 10);
        if (!date) continue;
        if (!byDate[date]) byDate[date] = { date, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        byDate[date].input_tokens  += e.input  || 0;
        byDate[date].output_tokens += e.output || 0;
        byDate[date].cost_usd      += e.cost_usd || 0;
      } catch (_) {}
    }
    const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ session: sessionName, daily });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /miniapp/send — accept {session, text, init_data}, validate and queue message
app.post('/miniapp/send', (req, res) => {
  const { session: sessionName, text, init_data } = req.body || {};
  if (!sessionName || !/^[a-zA-Z0-9_-]+$/.test(sessionName)) {
    return res.status(400).json({ error: 'Invalid session name' });
  }
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  // Validate Telegram initData (bypass in dev if no bot token)
  if (TG_BOT_TOKEN) {
    if (!init_data || !validateInitData(init_data, TG_BOT_TOKEN)) {
      return res.status(403).json({ error: 'Invalid or missing Telegram initData' });
    }
  }

  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === sessionName);
    if (!session) return res.status(404).json({ error: 'session not found' });

    // Extract user from initData if present
    let userName = 'miniapp';
    let userId = 0;
    try {
      const params = new URLSearchParams(init_data || '');
      const userJson = params.get('user');
      if (userJson) {
        const u = JSON.parse(userJson);
        userName = u.first_name || u.username || 'miniapp';
        userId = u.id || 0;
      }
    } catch (_) {}

    const entry = {
      message_id: -(Math.floor(Date.now() / 1000) % 2147483647),
      user: userName,
      user_id: userId,
      text: text.slice(0, 2000),
      ts: Math.floor(Date.now() / 1000),
      via: 'miniapp',
      force: true,
    };
    const queueFile = path.join(QUEUE_DIR, `tg-queue-${session.thread_id}.jsonl`);
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    fs.writeFileSync(path.join(QUEUE_DIR, `relay-msg-start-${session.thread_id}`), String(Date.now()));
    console.log(`[miniapp] ${sessionName}: ${userName}: ${text.substring(0, 60)}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[miniapp] send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

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

  // Set the bot's menu button to open the Mini App
  const MINIAPP_DOMAIN = process.env.MINIAPP_DOMAIN || (() => {
    // Derive domain from WEBHOOK_URL env if set (e.g. https://relay.right-api.com/webhook/...)
    const wu = process.env.WEBHOOK_URL || '';
    const m = wu.match(/^(https?:\/\/[^\/]+)/);
    return m ? m[1] : null;
  })();
  if (TG_BOT_TOKEN && MINIAPP_DOMAIN) {
    const miniappUrl = `${MINIAPP_DOMAIN}/miniapp`;
    fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: 'Open App', web_app: { url: miniappUrl } } }),
      signal: AbortSignal.timeout(8000),
    })
      .then(r => r.json())
      .then(d => console.log('[miniapp] setChatMenuButton:', d.ok ? 'ok' : JSON.stringify(d)))
      .catch(e => console.warn('[miniapp] setChatMenuButton failed:', e.message));
  } else {
    console.log('[miniapp] Skipping setChatMenuButton — set MINIAPP_DOMAIN or WEBHOOK_URL env var');
  }
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

// Tool call timeline — read session JSONL, audit log, and queue for chronological events
app.get('/api/timeline/:session', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sessionName = req.params.session.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const session = sessions.find(s => s.session === sessionName);
    if (!session) return res.status(404).json({ error: 'session not found' });

    const events = [];

    // 1. Read tool calls from Claude project JSONL
    const projectKey = session.path.replace(/\//g, '-').replace(/[^a-zA-Z0-9._-]/g, '-');
    const projectDir = `/root/.claude/projects/${projectKey}`;
    const latest = fs.existsSync(projectDir)
      ? fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')).sort().pop()
      : null;
    if (latest) {
      const lines = fs.readFileSync(path.join(projectDir, latest), 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines.slice(-300)) {
        try {
          const d = JSON.parse(line);
          if (d.type === 'assistant' && d.message?.content) {
            const content = d.message.content;
            for (const block of (Array.isArray(content) ? content : [])) {
              if (block.type === 'tool_use') {
                events.push({
                  ts: d.timestamp,
                  type: 'tool',
                  tool: block.name,
                  command: JSON.stringify(block.input || {}).slice(0, 120),
                });
              }
            }
          }
        } catch (_) {}
      }
    }

    // 2. Read messages from queue
    const threadId = session.thread_id;
    const queueFile = `/tmp/tg-queue-${threadId}.jsonl`;
    if (fs.existsSync(queueFile)) {
      const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines.slice(-200)) {
        try {
          const m = JSON.parse(line);
          if (!m.text) continue;
          events.push({
            ts: m.ts ? new Date(m.ts * 1000).toISOString() : new Date().toISOString(),
            type: 'message',
            text: (m.text || '').slice(0, 200),
            user: m.user || 'unknown',
          });
        } catch (_) {}
      }
    }

    // 3. Read audit log
    const auditFile = `/tmp/relay-audit-${threadId}.jsonl`;
    if (fs.existsSync(auditFile)) {
      const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines.slice(-200)) {
        try {
          const e = JSON.parse(line);
          events.push({
            ts: e.timestamp || (e.ts ? new Date(e.ts * 1000).toISOString() : new Date().toISOString()),
            type: e.type === 'tool_use' || e.event === 'tool_use' ? 'tool' : 'message',
            tool: e.tool || e.name,
            command: e.input ? JSON.stringify(e.input).slice(0, 120) : undefined,
            text: e.text ? String(e.text).slice(0, 200) : undefined,
            user: e.user,
          });
        } catch (_) {}
      }
    }

    // Sort chronologically and return last 100
    events.sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : 1);
    res.json(events.slice(-100));
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
