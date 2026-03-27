#!/usr/bin/env bun
/**
 * Telegram channel for Claude Code.
 *
 * MCP server that connects Claude Code to a Telegram topic (forum thread).
 * One instance per project — each knows its chat_id + thread_id.
 *
 * Config (env or ~/.claude/channels/telegram/.env):
 *   TELEGRAM_BOT_TOKEN  — bot token
 *   TELEGRAM_CHAT_ID    — supergroup chat id (negative number)
 *   TELEGRAM_THREAD_ID  — forum topic thread id
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

// ── config ────────────────────────────────────────────────────────────────────

const ENV_FILE = join(homedir(), '.claude', 'channels', 'telegram', '.env')

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID
const THREAD_ID = process.env.TELEGRAM_THREAD_ID ? parseInt(process.env.TELEGRAM_THREAD_ID) : undefined

if (!TOKEN || !CHAT_ID || !THREAD_ID) {
  process.stderr.write(
    `telegram channel: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID required\n` +
    `  set in ${ENV_FILE} or as environment variables\n`
  )
  process.exit(1)
}

const BASE = `https://api.telegram.org/bot${TOKEN}`

// ── message splitting ─────────────────────────────────────────────────────────

/** Split at newline boundaries; hard-split only when a single line exceeds maxLen. */
function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  const lines = text.split('\n')
  let current = ''
  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line
    if (candidate.length <= maxLen) {
      current = candidate
    } else {
      if (current) chunks.push(current)
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen))
        current = ''
      } else {
        current = line
      }
    }
  }
  if (current) chunks.push(current)
  return chunks
}

// ── auto-code wrapping ────────────────────────────────────────────────────────

/** Wrap copyable patterns (URLs, tokens) in <code> tags, skipping existing <code>/<pre> blocks. */
function autoCode(html: string): string {
  // Split by ALL HTML tags, track whether we're inside <code> or <pre>
  const segments = html.split(/(<[^>]*>)/g)
  let inProtected = 0

  return segments.map(seg => {
    if (seg.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(seg))        inProtected++
      else if (/^<\/(code|pre)\b/i.test(seg)) inProtected = Math.max(0, inProtected - 1)
      return seg
    }
    if (inProtected > 0) return seg

    // Wrap bare URLs
    seg = seg.replace(/https?:\/\/[^\s,<>"'()]+/g, m => `<code>${m}</code>`)
    return seg
  }).join('')
}

// ── peer topic logging ────────────────────────────────────────────────────────

async function logToPeersTopic(from: string, to: string, text: string): Promise<void> {
  try {
    const peerTopicPath = new URL('../peers-topic.json', import.meta.url).pathname
    const cfg = JSON.parse(readFileSync(peerTopicPath, 'utf8')) as { thread_id: number }
    const label = `<b>[${from} → ${to}]</b>\n${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}`
    await fetch(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        message_thread_id: cfg.thread_id,
        text: label,
        parse_mode: 'HTML',
      }),
    })
  } catch {}
}

// ── telegram helpers ──────────────────────────────────────────────────────────

async function tg(method: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const r = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

async function sendMessage(text: string, replyTo?: number, buttons?: string[][]): Promise<number[]> {
  text = autoCode(text)
  const chunks = splitMessage(text)
  const ids: number[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const body: Record<string, unknown> = {
      chat_id: CHAT_ID,
      message_thread_id: THREAD_ID,
      text: chunk,
      parse_mode: 'HTML',
    }
    if (replyTo) { body.reply_to_message_id = replyTo; replyTo = undefined }
    // Attach buttons only to the last chunk
    if (buttons && i === chunks.length - 1) {
      body.reply_markup = {
        inline_keyboard: buttons.map(row =>
          row.map(label => ({
            text: label,
            callback_data: `btn:${THREAD_ID}:${label}`,
          }))
        ),
      }
    }
    const res = await tg('sendMessage', body) as { ok: boolean; result: { message_id: number } }
    if (res.ok) ids.push(res.result.message_id)
  }
  return ids
}

async function editMessage(messageId: number, text: string): Promise<boolean> {
  const res = await tg('editMessageText', {
    chat_id: CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  }) as { ok: boolean }
  return res.ok
}

async function sendTyping(): Promise<void> {
  await tg('sendChatAction', {
    chat_id: CHAT_ID,
    message_thread_id: THREAD_ID,
    action: 'typing',
  })
}

async function sendReaction(messageId: number, emoji: string): Promise<boolean> {
  const res = await tg('setMessageReaction', {
    chat_id: CHAT_ID,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
    is_big: false,
  }) as { ok: boolean }
  return res.ok
}

// ── MCP server ────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'telegram-channel', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },  // enables notifications/claude/channel
    },
  }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to the Telegram topic. Supports HTML: <b>, <i>, <code>, <pre>. IMPORTANT: whenever you ask the user to confirm or choose between options, always include inline `buttons` (e.g. [["Yes","No"]] or [["A","B","C"]]) — never ask them to type a number or letter.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text:     { type: 'string',  description: 'Message text (HTML supported)' },
          reply_to: { type: 'integer', description: 'Optional message_id to reply to' },
          buttons:  {
            type: 'array',
            description: 'Optional inline keyboard buttons. Array of rows, each row is an array of button labels. When clicked, the label is sent back as a message. Example: [["Yes", "No"]] or [["Option A"], ["Option B"]]',
            items: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent.',
      inputSchema: {
        type: 'object',
        required: ['message_id', 'text'],
        properties: {
          message_id: { type: 'integer' },
          text:       { type: 'string' },
        },
      },
    },
    {
      name: 'typing',
      description: 'Show a typing indicator in the topic (lasts ~5s).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'fetch_messages',
      description: 'Get recent messages from this topic (up to last 50 stored).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 20, description: 'Max messages to return' },
        },
      },
    },
    {
      name: 'list_peers',
      description: 'List all other active Claude sessions in the relay. Shows session name, host, path, and when they last sent a message.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'send_file',
      description: 'Send a file from the server filesystem to the Telegram topic. Use this to share logs, exports, generated files, etc.',
      inputSchema: {
        type: 'object',
        required: ['file_path'],
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file on the server' },
          caption:   { type: 'string', description: 'Optional caption for the file' },
        },
      },
    },
    {
      name: 'message_peer',
      description: 'Send a message directly to another Claude session in the relay (peer-to-peer). The message will appear as an incoming user message in that session.',
      inputSchema: {
        type: 'object',
        required: ['session', 'text'],
        properties: {
          session: { type: 'string', description: 'Target session name (from list_peers)' },
          text:    { type: 'string', description: 'Message to send to the peer session' },
        },
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a message. Use to signal status: 👀 = working, ✅ = done, ❌ = error.',
      inputSchema: {
        type: 'object',
        required: ['message_id', 'emoji'],
        properties: {
          message_id: { type: 'integer', description: 'ID of the message to react to' },
          emoji:      { type: 'string',  description: 'Emoji to react with, e.g. "👀", "✅", "❌"' },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === 'send_message') {
    const text = String(args?.text ?? '')
    const ids = await sendMessage(
      text,
      args?.reply_to as number | undefined,
      args?.buttons as string[][] | undefined,
    )
    // Write response timestamp so the relay bot knows Claude replied
    void Bun.write(`/tmp/tg-last-sent-${THREAD_ID}`, String(Date.now() / 1000))

    // Auto-route @mentions to peer sessions
    // e.g. "@itops-dev can you check the Docker setup?" → forwarded to itops-dev session
    const mentions = [...text.matchAll(/@([\w-]+)/g)].map(m => m[1])
    if (mentions.length > 0) {
      try {
        const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
        const sessions: Array<{ session: string; thread_id: number; host?: string }> =
          JSON.parse(readFileSync(sessionsPath, 'utf8'))
        const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
        for (const mention of mentions) {
          const target = sessions.find(s => s.session === mention)
          if (!target || target.thread_id === THREAD_ID) continue
          const entry = JSON.stringify({
            text,
            user: `peer:${selfName}`,
            message_id: -Date.now(),
            thread_id: target.thread_id,
            ts: Date.now() / 1000,
            force: true,
          })
          const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
          if (target.host) {
            const proc = Bun.spawn(
              ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
               target.host, `cat >> ${queueFile}`],
              { stdin: new TextEncoder().encode(entry + '\n') }
            )
            await proc.exited
          } else {
            await Bun.write(queueFile, entry + '\n', { append: true })
          }
          void logToPeersTopic(selfName, mention, text)
          process.stderr.write(`[telegram] auto-routed @${mention} mention to peer session\n`)
        }
      } catch (e) {
        process.stderr.write(`[telegram] @mention routing error: ${e}\n`)
      }
    }

    return { content: [{ type: 'text', text: `Sent. message_ids: ${ids.join(', ')}` }] }
  }

  if (name === 'send_file') {
    const filePath = String(args?.file_path ?? '')
    const caption  = args?.caption ? String(args.caption) : undefined
    try {
      const file = Bun.file(filePath)
      if (!(await file.exists())) {
        return { content: [{ type: 'text', text: `File not found: ${filePath}` }] }
      }
      const blob = await file.arrayBuffer()
      const fileName = filePath.split('/').pop() ?? 'file'
      const form = new FormData()
      form.append('chat_id', String(CHAT_ID))
      form.append('message_thread_id', String(THREAD_ID))
      form.append('document', new File([blob], fileName))
      if (caption) form.append('caption', caption)
      const r = await fetch(`${BASE}/sendDocument`, { method: 'POST', body: form })
      const res = await r.json() as { ok: boolean; result?: { message_id: number } }
      if (res.ok) {
        return { content: [{ type: 'text', text: `File sent (message_id: ${res.result?.message_id})` }] }
      } else {
        return { content: [{ type: 'text', text: `Failed to send file: ${JSON.stringify(res)}` }] }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error sending file: ${e}` }] }
    }
  }

  if (name === 'edit_message') {
    const ok = await editMessage(Number(args?.message_id), String(args?.text ?? ''))
    return { content: [{ type: 'text', text: ok ? 'Edited.' : 'Failed to edit.' }] }
  }

  if (name === 'typing') {
    await sendTyping()
    return { content: [{ type: 'text', text: 'Typing indicator sent.' }] }
  }

  if (name === 'fetch_messages') {
    const limit = Number(args?.limit ?? 20)
    const recent = dbRecent(limit)
    const lines = recent.map(m => `[${m.ts}] ${m.user} (id:${m.message_id}): ${m.text}`)
    return { content: [{ type: 'text', text: lines.join('\n') || 'No messages yet.' }] }
  }

  if (name === 'list_peers') {
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string; path?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const lines: string[] = []
      for (const s of sessions) {
        if (s.thread_id === THREAD_ID) continue  // skip self
        const lastSentFile = `/tmp/tg-last-sent-${s.thread_id}`
        let lastActive = 'unknown'
        try {
          let raw: string
          if (s.host) {
            const proc = Bun.spawn(
              ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=3',
               s.host, `cat ${lastSentFile} 2>/dev/null`]
            )
            raw = await new Response(proc.stdout).text()
          } else {
            raw = await Bun.file(lastSentFile).text()
          }
          const ts = parseFloat(raw.trim())
          if (!isNaN(ts)) {
            const ago = Math.round((Date.now() / 1000 - ts) / 60)
            lastActive = ago < 1 ? 'just now' : `${ago}m ago`
          }
        } catch {}
        const host = s.host ?? 'local'
        lines.push(`${s.session} (${host}) — last active: ${lastActive}`)
      }
      return { content: [{ type: 'text', text: lines.join('\n') || 'No other sessions.' }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading sessions: ${e}` }] }
    }
  }

  if (name === 'message_peer') {
    const targetSession = String(args?.session ?? '')
    const text = String(args?.text ?? '')
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const target = sessions.find(s => s.session === targetSession)
      if (!target) return { content: [{ type: 'text', text: `Session '${targetSession}' not found. Use list_peers to see available sessions.` }] }

      const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
      const entry = JSON.stringify({
        text,
        user: `peer:${process.env.SESSION_NAME ?? `session-${THREAD_ID}`}`,
        message_id: -Date.now(),  // negative so it never advances lastId (peer msgs are force=true)
        thread_id: target.thread_id,
        ts: Date.now() / 1000,
        force: true,
      })

      if (target.host) {
        // Remote session — write via SSH
        const proc = Bun.spawn(
          ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
           target.host, `cat >> ${queueFile}`],
          { stdin: new TextEncoder().encode(entry + '\n') }
        )
        await proc.exited
        if (proc.exitCode !== 0) throw new Error(`SSH exit code ${proc.exitCode}`)
      } else {
        await Bun.write(queueFile, entry + '\n', { append: true })
      }
      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
      void logToPeersTopic(selfName, targetSession, text)
      return { content: [{ type: 'text', text: `Message sent to '${targetSession}' (${target.host ?? 'local'}).` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error sending to peer: ${e}` }] }
    }
  }

  if (name === 'react') {
    const ok = await sendReaction(Number(args?.message_id), String(args?.emoji ?? '👍'))
    return { content: [{ type: 'text', text: ok ? 'Reaction sent.' : 'Failed to send reaction.' }] }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
})

// ── message history (SQLite, last 500, persists across restarts) ──────────────

type TgMessage = {
  message_id: number
  user: string
  text: string
  ts: string
}

const db = new Database(`/tmp/tg-history-${THREAD_ID}.db`)
db.run(`CREATE TABLE IF NOT EXISTS messages (
  rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  user     TEXT,
  text     TEXT,
  ts       TEXT
)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_ts ON messages(ts)`)

function dbInsert(msg: TgMessage): void {
  db.run('INSERT INTO messages (message_id, user, text, ts) VALUES (?, ?, ?, ?)',
    [msg.message_id, msg.user, msg.text, msg.ts])
  db.run('DELETE FROM messages WHERE rowid NOT IN (SELECT rowid FROM messages ORDER BY rowid DESC LIMIT 500)')
}

function dbRecent(limit: number): TgMessage[] {
  return (db.query('SELECT message_id, user, text, ts FROM messages ORDER BY rowid DESC LIMIT ?').all(limit) as TgMessage[]).reverse()
}

// ── Queue file reader (routing bot writes here, we consume) ──────────────────
// This avoids conflicts with the routing bot both polling getUpdates.

const QUEUE_FILE = `/tmp/tg-queue-${THREAD_ID}.jsonl`
const LOCK_FILE  = `/tmp/tg-queue-${THREAD_ID}.lock`

// Kill any previous instance for this thread before starting
try {
  const f = Bun.file(LOCK_FILE)
  if (await f.exists()) {
    const oldPid = parseInt(await f.text(), 10)
    if (oldPid && oldPid !== process.pid) {
      try { process.kill(oldPid, 0); process.kill(oldPid) } catch {}
    }
  }
} catch {}
await Bun.write(LOCK_FILE, String(process.pid))
function cleanup() { try { require('fs').unlinkSync(LOCK_FILE) } catch {} }
process.on('exit', cleanup)
process.on('SIGTERM', () => { cleanup(); process.exit(0) })
process.on('SIGINT',  () => { cleanup(); process.exit(0) })

type QueueEntry = {
  text: string
  user: string
  message_id: number
  thread_id: number
  chat_id: number
  ts: number
  photo_path?: string
}

// Persistent state: last delivered message_id survives MCP restarts
const STATE_FILE = `/tmp/tg-queue-${THREAD_ID}.state`

async function loadLastId(): Promise<number> {
  try {
    const f = Bun.file(STATE_FILE)
    if (await f.exists()) {
      const id = parseInt(await f.text(), 10) || 0
      // Unix-timestamp IDs (> 1e8) are corrupted — current epoch is ~1.77e9, Telegram msg IDs stay well below 1e8
      if (id > 1e8) {
        process.stderr.write(`[telegram] state ${id} looks like a Unix timestamp, resetting to 0\n`)
        await saveLastId(0)
        return 0
      }
      return id
    }
  } catch {}
  return 0
}

async function saveLastId(id: number): Promise<void> {
  try { await Bun.write(STATE_FILE, String(id)) } catch {}
}

/** Remove queue entries older than 24h that have already been delivered. */
async function trimQueue(lastId: number): Promise<void> {
  try {
    const file = Bun.file(QUEUE_FILE)
    if (!(await file.exists())) return
    const cutoff = Date.now() / 1000 - 24 * 60 * 60
    const lines = (await file.text()).split('\n').filter(line => {
      if (!line.trim()) return false
      try {
        const e = JSON.parse(line) as QueueEntry & { force?: boolean }
        // Keep: recent entries OR undelivered regular messages
        if (e.ts > cutoff) return true
        if (!e.force && e.message_id > lastId) return true
        return false
      } catch { return false }
    })
    await Bun.write(QUEUE_FILE, lines.join('\n') + (lines.length ? '\n' : ''))
  } catch {}
}

async function poll(): Promise<void> {
  // Deliver any message with message_id > lastDeliveredId, one per poll cycle
  let lastId = await loadLastId()
  const deliveredForce = new Map<number, number>()  // message_id → delivery timestamp (ms)

  // Sanity-check lastId against queue on startup:
  // If the most recently received message (by ts) has a lower ID than lastId,
  // lastId is stale (old test messages or session reset) — rewind to just before it.
  try {
    const qFile = Bun.file(QUEUE_FILE)
    if (await qFile.exists()) {
      const qText = await qFile.text()
      const entries = qText.split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l) as QueueEntry } catch { return null } })
        .filter((e): e is QueueEntry => e !== null && e.ts < 1e12)
      if (entries.length > 0) {
        const mostRecent = entries.reduce((a, b) => b.ts > a.ts ? b : a)
        if (lastId > mostRecent.message_id && lastId > mostRecent.message_id + 100) {
          process.stderr.write(
            `[telegram] stale lastId=${lastId}, most recent msg id=${mostRecent.message_id} — resetting\n`
          )
          lastId = Math.max(0, mostRecent.message_id - 1)
          await saveLastId(lastId)
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[telegram] state sanity check error: ${e}\n`)
  }

  // Pre-populate deliveredForce with all force entries that are already behind lastId.
  // Without this, every server restart would re-deliver old button clicks to Claude.
  try {
    const qFile = Bun.file(QUEUE_FILE)
    if (await qFile.exists()) {
      for (const line of (await qFile.text()).split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as QueueEntry & { force?: boolean }
          if (e.force && e.message_id < lastId) {
            // Only permanently skip old force entries (> 5 min).
            // Recent button clicks should still be re-delivered after a context restart.
            const ageMs = Date.now() - e.ts * 1000
            if (ageMs > 4 * 60 * 60 * 1000) {
              deliveredForce.set(e.message_id, Infinity)
            }
          }
        } catch {}
      }
    }
  } catch {}

  // Brief pause to let the MCP handshake complete before first notification
  await Bun.sleep(1000)

  // Inject peer list as a system notification so Claude knows available sessions on startup
  try {
    const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
    const allSessions: Array<{ session: string; thread_id: number; host?: string }> =
      JSON.parse(readFileSync(sessionsPath, 'utf8'))
    const peers = allSessions.filter(s => s.thread_id !== THREAD_ID).map(s => s.session)
    if (peers.length > 0) {
      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
      server.notification({
        method: 'notifications/message',
        params: {
          level: 'info',
          data: `[relay] You are session "${selfName}". Available peer sessions: ${peers.join(', ')}. ` +
                `Use message_peer(session, text) to contact them, or include @session-name in send_message to auto-route.`,
        },
      })
    }
  } catch {}

  let pollCount = 0
  while (true) {
    pollCount++
    // Trim queue every ~5 minutes (600 cycles × 500ms)
    if (pollCount % 600 === 0) void trimQueue(lastId)

    try {
      const file = Bun.file(QUEUE_FILE)
      if (!(await file.exists())) { await Bun.sleep(500); continue }

      const text = await file.text()
      let sentOne = false

      for (const line of text.split('\n')) {
        if (!line.trim() || sentOne) continue
        try {
          const entry = JSON.parse(line) as QueueEntry & { force?: boolean }
          const { text: msgText, user, message_id, ts, photo_path, force } = entry

          // Skip already-delivered messages.
          // Exception: deliver recent regular messages (< 10 min old) even if message_id <= lastId,
          // in case lastId jumped ahead (e.g. due to a bot outgoing message ID collision).
          const ageMs = Date.now() - ts * 1000
          const isRecent = ageMs < 10 * 60 * 1000
          if (message_id <= lastId && !force && !isRecent) continue
          if (message_id <= lastId && !force && isRecent && deliveredForce.has(-message_id)) continue  // dedupe recent
          if (force && deliveredForce.has(message_id) && Date.now() - deliveredForce.get(message_id)! < 15_000) continue

          const isoTs = new Date(ts * 1000).toISOString()

          dbInsert({ message_id, user, text: msgText, ts: isoTs })

          process.stderr.write(`[telegram] sending notification: ${user}: ${msgText}\n`)

          void mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: msgText,
              meta: {
                chat_id:    String(CHAT_ID),
                thread_id:  String(THREAD_ID),
                message_id,
                user,
                ts:         isoTs,
                ...(photo_path ? { photo_path } : {}),
              },
            },
          })

          // Force messages: always track in deliveredForce; never advance lastId
          // (their IDs reuse the button-message ID, not sequential message IDs)
          if (force) {
            deliveredForce.set(message_id, Date.now())
          } else if (message_id <= lastId && isRecent) {
            // Recent message delivered despite being behind lastId — mark deduped
            deliveredForce.set(-message_id, Date.now())
          } else if (message_id > lastId) {
            // Regular messages advance lastId
            lastId = message_id
            await saveLastId(lastId)
          }
          sentOne = true  // send only one per cycle; next will be picked up on next poll

          process.stderr.write(`[telegram] notification sent: ${user}: ${msgText}\n`)
        } catch (e) {
          process.stderr.write(`[telegram] parse error: ${e}\n`)
        }
      }
    } catch (err) {
      process.stderr.write(`[telegram] poll error: ${err}\n`)
    }

    await Bun.sleep(500)
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await mcp.connect(transport)

// Start polling after connecting
void poll()

process.stderr.write(`[telegram] MCP server ready — listening on topic ${THREAD_ID} in chat ${CHAT_ID}\n`)
