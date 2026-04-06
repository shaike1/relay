#!/usr/bin/env node
/**
 * discord-bridge — bidirectional Discord ↔ relay bridge.
 *
 * Incoming (Discord → relay):
 *   Reads sessions.json to map discord_channel_id → thread_id.
 *   On message: writes to /tmp/tg-queue-{thread_id}.jsonl (same format as Telegram).
 *   Saves /tmp/discord-ctx-{thread_id} so the MCP knows to reply to Discord.
 *
 * Outgoing (relay → Discord):
 *   HTTP server on DISCORD_BRIDGE_PORT (default 9102).
 *   POST /send { thread_id, text } → sends to mapped Discord channel.
 *
 * Configuration (env vars):
 *   DISCORD_BOT_TOKEN     — Discord bot token (required)
 *   DISCORD_BRIDGE_PORT   — HTTP port for outbound send (default 9102)
 *   SESSIONS_FILE         — path to sessions.json (default /relay/sessions.json)
 *   QUEUE_DIR             — queue directory (default /tmp)
 */

'use strict';

const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const PORT = parseInt(process.env.DISCORD_BRIDGE_PORT || '9102');
const SESSIONS_FILE = process.env.SESSIONS_FILE || '/relay/sessions.json';
const QUEUE_DIR = process.env.QUEUE_DIR || '/tmp';

if (!DISCORD_BOT_TOKEN) {
  console.error('[discord-bridge] DISCORD_BOT_TOKEN not set — exiting');
  process.exit(1);
}

// Build channel→thread map from sessions.json
function loadChannelMap() {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const map = {}; // discord_channel_id → thread_id
    for (const s of sessions) {
      if (s.discord_channel_id && s.thread_id) {
        map[String(s.discord_channel_id)] = s.thread_id;
      }
    }
    return map;
  } catch (e) {
    console.error('[discord-bridge] Failed to load sessions.json:', e.message);
    return {};
  }
}

// Reload map every 60s to pick up sessions.json changes
let channelMap = loadChannelMap();
setInterval(() => { channelMap = loadChannelMap(); }, 60000);

// Write incoming Discord message to relay queue
function writeToQueue(threadId, user, text, discordMsgId, channelId) {
  const queueFile = path.join(QUEUE_DIR, `tg-queue-${threadId}.jsonl`);
  const entry = {
    message_id: discordMsgId % 2147483647, // fit in int32
    user,
    text,
    ts: Math.floor(Date.now() / 1000),
    via: 'discord',
    discord_channel_id: String(channelId),
  };
  try {
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    // Save Discord context so MCP can route reply back
    const ctxFile = path.join(QUEUE_DIR, `discord-ctx-${threadId}`);
    fs.writeFileSync(ctxFile, JSON.stringify({ channel_id: String(channelId) }));
    console.log(`[discord-bridge] thread ${threadId} ← ${user}: ${text.substring(0, 60)}`);
  } catch (e) {
    console.error('[discord-bridge] Queue write error:', e.message);
  }
}

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`[discord-bridge] Logged in as ${client.user.tag}`);
  console.log(`[discord-bridge] Mapped channels: ${JSON.stringify(channelMap)}`);
});

client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  const channelId = String(message.channel.id);
  const threadId = channelMap[channelId];
  if (!threadId) return; // not a mapped channel

  const user = message.member?.displayName || message.author.username;
  const text = message.content;
  if (!text) return;

  // Use BigInt message id, mod to int range
  const msgId = Number(BigInt(message.id) % BigInt(2147483647));
  writeToQueue(threadId, user, text, msgId, channelId);
});

client.login(DISCORD_BOT_TOKEN).catch(e => {
  console.error('[discord-bridge] Login failed:', e.message);
  process.exit(1);
});

// HTTP server for outbound sends: POST /send { thread_id, text }
const server = http.createServer((req, res) => {
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
      // Find Discord channel for this thread
      const ctxFile = path.join(QUEUE_DIR, `discord-ctx-${thread_id}`);
      let channelId = null;
      if (fs.existsSync(ctxFile)) {
        try { channelId = JSON.parse(fs.readFileSync(ctxFile, 'utf8')).channel_id; } catch (_) {}
      }
      // Also check sessions.json directly
      if (!channelId) {
        try {
          const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
          const s = sessions.find(x => String(x.thread_id) === String(thread_id));
          if (s && s.discord_channel_id) channelId = String(s.discord_channel_id);
        } catch (_) {}
      }
      if (!channelId) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: `No Discord channel mapped for thread ${thread_id}` }));
      }
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'Channel not found or not text-based' }));
      }
      // Discord has 2000 char limit per message; split if needed
      const chunks = [];
      for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
      for (const chunk of chunks) await channel.send(chunk);
      console.log(`[discord-bridge] thread ${thread_id} → Discord ${channelId}: ${text.substring(0, 60)}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[discord-bridge] Send error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[discord-bridge] HTTP server listening on :${PORT}`);
});
