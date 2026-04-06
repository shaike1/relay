#!/usr/bin/env node
/**
 * whatsapp-bridge — bidirectional WhatsApp ↔ relay bridge.
 *
 * Uses whatsapp-web.js (unofficial, works via WhatsApp Web QR auth).
 *
 * Incoming (WhatsApp → relay):
 *   Maps whatsapp_jid → thread_id via sessions.json.
 *   On message: writes to /tmp/tg-queue-{thread_id}.jsonl.
 *   Saves /tmp/whatsapp-ctx-{thread_id} = {jid} for reply routing.
 *
 * Outgoing (relay → WhatsApp):
 *   HTTP server on WA_BRIDGE_PORT (default 9103).
 *   POST /send { thread_id, text } → sends to mapped WhatsApp chat.
 *
 * Auth:
 *   On first start, generates a QR code and sends it to Telegram
 *   (WA_QR_THREAD_ID) as a photo. User scans → authenticated.
 *   Session persists in WA_SESSION_DIR across restarts.
 *
 * Configuration (env vars):
 *   TELEGRAM_BOT_TOKEN    — bot token (for QR delivery)
 *   TELEGRAM_CHAT_ID      — group chat id
 *   WA_QR_THREAD_ID       — thread to send QR code to (default: 183)
 *   WA_SESSION_DIR        — where to persist auth session (default /wa-session)
 *   WA_BRIDGE_PORT        — HTTP port (default 9103)
 *   SESSIONS_FILE         — path to sessions.json (default /relay/sessions.json)
 *   QUEUE_DIR             — queue directory (default /tmp)
 *   WA_DEFAULT_THREAD_ID  — fallback thread for unknown senders (optional)
 */

'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.GROUP_CHAT_ID;
const QR_THREAD_ID = process.env.WA_QR_THREAD_ID || '183';
const SESSION_DIR = process.env.WA_SESSION_DIR || '/wa-session';
const PORT = parseInt(process.env.WA_BRIDGE_PORT || '9103');
const SESSIONS_FILE = process.env.SESSIONS_FILE || '/relay/sessions.json';
const QUEUE_DIR = process.env.QUEUE_DIR || '/tmp';
const DEFAULT_THREAD_ID = process.env.WA_DEFAULT_THREAD_ID || null;

// Load env from /root/relay/.env if present
try {
  const envFile = fs.readFileSync('/root/relay/.env', 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch (_) {}

// Reload sessions.json every 60s
function loadJidMap() {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const map = {}; // jid → thread_id
    for (const s of sessions) {
      if (s.whatsapp_jid && s.thread_id) {
        // Normalize JID: ensure it ends with @c.us or @g.us
        const jid = String(s.whatsapp_jid).includes('@') ? s.whatsapp_jid : `${s.whatsapp_jid}@c.us`;
        map[jid] = s.thread_id;
      }
    }
    return map;
  } catch (e) {
    console.error('[wa-bridge] Failed to load sessions.json:', e.message);
    return {};
  }
}

let jidMap = loadJidMap();
setInterval(() => { jidMap = loadJidMap(); }, 60000);

// Write incoming WhatsApp message to relay queue
function writeToQueue(threadId, user, text, jid) {
  const queueFile = path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
  const entry = {
    message_id: Math.floor(Date.now() / 1000) % 2147483647,
    user,
    text,
    ts: Math.floor(Date.now() / 1000),
    via: 'whatsapp',
    whatsapp_jid: jid,
  };
  try {
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    // Save WhatsApp context for reply routing
    const ctxFile = path.join(QUEUE_DIR, `whatsapp-ctx-${threadId}`);
    fs.writeFileSync(ctxFile, JSON.stringify({ jid }));
    console.log(`[wa-bridge] thread ${threadId} ← ${user} (${jid}): ${text.substring(0, 60)}`);
  } catch (e) {
    console.error('[wa-bridge] Queue write error:', e.message);
  }
}

// Send QR code image to Telegram
async function sendQrToTelegram(qrData) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('[wa-bridge] QR (no Telegram configured):');
    require('qrcode-terminal').generate(qrData, { small: true });
    return;
  }
  try {
    // Generate QR as PNG buffer
    const qrBuffer = await qrcode.toBuffer(qrData, { type: 'png', width: 300 });
    const tmpFile = '/tmp/wa-qr.png';
    fs.writeFileSync(tmpFile, qrBuffer);

    // Send via Telegram Bot API sendPhoto
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('message_thread_id', QR_THREAD_ID);
    form.append('caption', '📱 <b>WhatsApp QR Code</b>\nסרוק עם WhatsApp ← Linked Devices', { contentType: 'text/plain' });
    form.append('parse_mode', 'HTML');
    form.append('photo', fs.createReadStream(tmpFile), { filename: 'qr.png', contentType: 'image/png' });

    await new Promise((resolve, reject) => {
      const req = https.request(
        `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
        { method: 'POST', headers: form.getHeaders() },
        res => { res.resume(); resolve(); }
      );
      req.on('error', reject);
      form.pipe(req);
    });
    console.log('[wa-bridge] QR code sent to Telegram thread', QR_THREAD_ID);
  } catch (e) {
    console.error('[wa-bridge] Failed to send QR to Telegram:', e.message);
  }
}

// Send text to Telegram (for status notifications)
function tgNotify(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const body = JSON.stringify({
    chat_id: TG_CHAT_ID,
    message_thread_id: parseInt(QR_THREAD_ID),
    text,
    parse_mode: 'HTML',
  });
  const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => { res.resume(); });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', async (qr) => {
  console.log('[wa-bridge] QR received — sending to Telegram');
  await sendQrToTelegram(qr);
});

client.on('ready', () => {
  console.log('[wa-bridge] WhatsApp client ready!');
  tgNotify('✅ <b>WhatsApp Bridge</b> מחובר ופעיל');
});

client.on('auth_failure', (msg) => {
  console.error('[wa-bridge] Auth failure:', msg);
  tgNotify(`❌ <b>WhatsApp Bridge</b> — כשל אימות: ${msg}`);
});

client.on('disconnected', (reason) => {
  console.log('[wa-bridge] Disconnected:', reason);
  tgNotify(`⚠️ <b>WhatsApp Bridge</b> התנתק: ${reason}`);
});

client.on('message', async (msg) => {
  if (msg.fromMe) return;
  const jid = msg.from; // e.g. 972501234567@c.us or group@g.us
  const body = msg.body || '';
  if (!body) return;

  // Find thread for this JID
  let threadId = jidMap[jid];

  // Try normalized JID (strip suffix)
  if (!threadId) {
    const bareJid = jid.split('@')[0];
    for (const [mappedJid, tid] of Object.entries(jidMap)) {
      if (mappedJid.startsWith(bareJid)) { threadId = tid; break; }
    }
  }

  // Fall back to default thread if configured
  if (!threadId && DEFAULT_THREAD_ID) {
    threadId = DEFAULT_THREAD_ID;
  }

  if (!threadId) {
    console.log(`[wa-bridge] No thread mapped for ${jid} — ignoring`);
    return;
  }

  const contact = await msg.getContact();
  const user = contact.pushname || contact.name || jid.split('@')[0];
  writeToQueue(threadId, user, body, jid);
});

console.log('[wa-bridge] Starting WhatsApp client...');
client.initialize().catch(e => {
  console.error('[wa-bridge] Init error:', e.message);
  process.exit(1);
});

// HTTP server for outbound: POST /send { thread_id, text }
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, state: client.info ? 'ready' : 'connecting' }));
  }
  if (req.method !== 'POST' || req.url !== '/send') {
    res.writeHead(404);
    return res.end('Not found');
  }
  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    try {
      const { thread_id, text } = JSON.parse(body);
      if (!thread_id || !text) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'thread_id and text required' }));
      }

      // Find JID for this thread
      let targetJid = null;
      const ctxFile = path.join(QUEUE_DIR, `whatsapp-ctx-${thread_id}`);
      if (fs.existsSync(ctxFile)) {
        try { targetJid = JSON.parse(fs.readFileSync(ctxFile, 'utf8')).jid; } catch (_) {}
      }
      if (!targetJid) {
        // Look up in sessions.json
        try {
          const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
          const s = sessions.find(x => String(x.thread_id) === String(thread_id));
          if (s && s.whatsapp_jid) {
            targetJid = String(s.whatsapp_jid).includes('@') ? s.whatsapp_jid : `${s.whatsapp_jid}@c.us`;
          }
        } catch (_) {}
      }
      if (!targetJid) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: `No WhatsApp JID for thread ${thread_id}` }));
      }

      // WhatsApp has 4096 char limit
      const chunks = [];
      for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
      for (const chunk of chunks) {
        await client.sendMessage(targetJid, chunk);
      }
      console.log(`[wa-bridge] thread ${thread_id} → WhatsApp ${targetJid}: ${text.substring(0, 60)}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[wa-bridge] Send error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[wa-bridge] HTTP server listening on :${PORT}`);
});
