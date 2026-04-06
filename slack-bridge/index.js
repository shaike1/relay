/**
 * slack-bridge — bidirectional Slack ↔ relay bridge.
 *
 * Incoming (Slack → relay):
 *   Reads sessions.json to map slack_channel_id → thread_id.
 *   On message: writes to /tmp/tg-queue-{thread_id}.jsonl (same format as Telegram).
 *   Saves /tmp/slack-ctx-{thread_id} so the MCP knows to reply to Slack.
 *
 * Outgoing (relay → Slack):
 *   HTTP server on SLACK_BRIDGE_PORT (default 9104).
 *   POST /send { thread_id, text } → sends to mapped Slack channel.
 *
 * Configuration (env vars):
 *   SLACK_BOT_TOKEN       — xoxb-... bot token (required)
 *   SLACK_APP_TOKEN       — xapp-... app-level token for Socket Mode (required)
 *   SLACK_BRIDGE_PORT     — HTTP port for outbound send (default 9104)
 *   SESSIONS_FILE         — path to sessions.json (default /relay/sessions.json)
 *   QUEUE_DIR             — queue directory (default /tmp)
 */

import { App } from '@slack/bolt';
import { createServer } from 'http';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN  = process.env.SLACK_APP_TOKEN;
const PORT             = parseInt(process.env.SLACK_BRIDGE_PORT || '9104');
const SESSIONS_FILE    = process.env.SESSIONS_FILE || '/relay/sessions.json';
const QUEUE_DIR        = process.env.QUEUE_DIR || '/tmp';

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error('[slack-bridge] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required — exiting');
  process.exit(1);
}

// Build channel→thread map from sessions.json
function loadChannelMap() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    const map = {}; // slack_channel_id → thread_id
    for (const s of sessions) {
      if (s.slack_channel_id && s.thread_id) {
        map[String(s.slack_channel_id)] = s.thread_id;
      }
    }
    return map;
  } catch (e) {
    console.error('[slack-bridge] Failed to load sessions.json:', e.message);
    return {};
  }
}

let channelMap = loadChannelMap();
// Reload every 60s to pick up sessions.json changes
setInterval(() => { channelMap = loadChannelMap(); }, 60000);

// Write incoming Slack message to relay queue
function writeToQueue(threadId, user, text, slackMsgTs, channelId) {
  const queueFile = join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
  // Convert Slack ts (e.g. "1700000000.123456") to a positive int32-safe message_id
  const msgId = Math.abs(Math.floor(parseFloat(slackMsgTs || '0'))) % 2147483647;
  const entry = {
    message_id: msgId || Math.floor(Date.now() / 1000) % 2147483647,
    user,
    text,
    ts: Math.floor(Date.now() / 1000),
    via: 'slack',
    slack_channel_id: String(channelId),
  };
  try {
    appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    // Save Slack context so MCP can route reply back
    const ctxFile = join(QUEUE_DIR, `slack-ctx-${threadId}`);
    writeFileSync(ctxFile, JSON.stringify({ channel_id: String(channelId) }));
    console.log(`[slack-bridge] thread ${threadId} ← ${user}: ${text.substring(0, 60)}`);
  } catch (e) {
    console.error('[slack-bridge] Queue write error:', e.message);
  }
}

// Initialise Slack Bolt app with Socket Mode (no public inbound HTTP needed)
const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// Listen for messages in configured channels
slackApp.message(async ({ message, say }) => {
  // Ignore bot messages and subtypes (edits, deletions, etc.)
  if (message.subtype || message.bot_id) return;
  const channelId = String(message.channel);
  const threadId  = channelMap[channelId];
  if (!threadId) return; // not a mapped channel

  const user = message.username || (message.user ? `user-${message.user}` : 'unknown');
  const text = message.text || '';
  if (!text) return;

  writeToQueue(threadId, user, text, message.ts, channelId);
});

// Start the Bolt app
(async () => {
  await slackApp.start();
  console.log('[slack-bridge] Slack Socket Mode app started');
})().catch(e => {
  console.error('[slack-bridge] Failed to start Slack app:', e.message);
  process.exit(1);
});

// ── Outbound HTTP server: POST /send { thread_id, text } ─────────────────────

const httpServer = createServer((req, res) => {
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

      // Find Slack channel for this thread
      const ctxFile = join(QUEUE_DIR, `slack-ctx-${thread_id}`);
      let channelId = null;

      if (existsSync(ctxFile)) {
        try { channelId = JSON.parse(readFileSync(ctxFile, 'utf8')).channel_id; } catch (_) {}
      }
      // Also check sessions.json directly
      if (!channelId) {
        try {
          const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
          const s = sessions.find(x => String(x.thread_id) === String(thread_id));
          if (s && s.slack_channel_id) channelId = String(s.slack_channel_id);
        } catch (_) {}
      }

      if (!channelId) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: `No Slack channel mapped for thread ${thread_id}` }));
      }

      // Slack has 4000 char limit; split if needed
      const chunks = [];
      for (let i = 0; i < text.length; i += 3800) chunks.push(text.slice(i, i + 3800));
      for (const chunk of chunks) {
        await slackApp.client.chat.postMessage({ channel: channelId, text: chunk });
      }
      console.log(`[slack-bridge] thread ${thread_id} → Slack ${channelId}: ${text.substring(0, 60)}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[slack-bridge] Send error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[slack-bridge] Outbound HTTP server listening on :${PORT}`);
});
