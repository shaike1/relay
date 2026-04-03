#!/usr/bin/env node
/**
 * codex-bot.js — Standalone Telegram bot for the Codex session.
 *
 * Polls Telegram for messages in the Codex topic, writes them to the
 * queue file. The existing message-watchdog injects them into Codex's
 * tmux session. Zero Claude dependency.
 *
 * Environment:
 *   CODEX_BOT_TOKEN     — dedicated bot token (from BotFather)
 *   GROUP_CHAT_ID       — group chat ID
 *   CODEX_THREAD_ID     — topic thread ID for codex (default: 8542)
 *   QUEUE_DIR           — directory for queue files (default: /tmp)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Config ---
const BOT_TOKEN = process.env.CODEX_BOT_TOKEN;
const CHAT_ID = process.env.GROUP_CHAT_ID;
const THREAD_ID = parseInt(process.env.CODEX_THREAD_ID || '8542', 10);
const QUEUE_DIR = process.env.QUEUE_DIR || '/tmp';
const QUEUE_FILE = path.join(QUEUE_DIR, `tg-queue-${THREAD_ID}.jsonl`);
const STATE_FILE = path.join(QUEUE_DIR, `codex-bot-state.json`);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[codex-bot] Missing CODEX_BOT_TOKEN or GROUP_CHAT_ID');
  process.exit(1);
}

// --- State ---
let lastUpdateId = 0;
try {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  lastUpdateId = state.lastUpdateId || 0;
} catch {}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ lastUpdateId })); } catch {}
}

// --- Telegram API ---
function apiCall(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Queue ---
function writeToQueue(msg) {
  const entry = {
    message_id: msg.message_id,
    user: (msg.from && (msg.from.first_name || msg.from.username)) || 'unknown',
    user_id: msg.from && msg.from.id,
    text: msg.text || '',
    ts: Math.floor(Date.now() / 1000),
    via: 'codex-bot'
  };
  try {
    fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[codex-bot] Queue write error:', err.message);
  }
}

// --- Long polling ---
async function poll() {
  try {
    const result = await apiCall('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message']
    });

    if (!result || !result.ok || !result.result) return;

    for (const update of result.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg) continue;

      // Only process messages from our group
      if (String(msg.chat.id) !== String(CHAT_ID)) continue;

      // Only process messages from the codex topic
      if (msg.message_thread_id !== THREAD_ID) continue;

      // Skip bot messages
      if (msg.from && msg.from.is_bot) continue;

      // Skip non-text
      if (!msg.text) continue;

      console.log(`[codex-bot] ${msg.from.first_name}: ${msg.text.substring(0, 80)}`);
      writeToQueue(msg);
    }

    saveState();
  } catch (err) {
    console.error('[codex-bot] Poll error:', err.message);
    // Wait before retrying on error
    await new Promise(r => setTimeout(r, 5000));
  }
}

// --- Main ---
async function main() {
  console.log(`[codex-bot] Starting — thread ${THREAD_ID}, queue ${QUEUE_FILE}`);
  console.log(`[codex-bot] Bot token fingerprint: ...${BOT_TOKEN.slice(-6)}`);

  // Verify bot token
  const me = await apiCall('getMe', {});
  if (!me || !me.ok) {
    console.error('[codex-bot] Invalid bot token');
    process.exit(1);
  }
  console.log(`[codex-bot] Bot: @${me.result.username} (${me.result.first_name})`);

  // Long-polling loop
  while (true) {
    await poll();
  }
}

main().catch(err => {
  console.error('[codex-bot] Fatal:', err);
  process.exit(1);
});
