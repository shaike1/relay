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
  const chunks = text.match(/.{1,4000}/gs) ?? [text]
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
      description: 'Send a message to the Telegram topic. Supports HTML: <b>, <i>, <code>, <pre>.',
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
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === 'send_message') {
    const ids = await sendMessage(
      String(args?.text ?? ''),
      args?.reply_to as number | undefined,
      args?.buttons as string[][] | undefined,
    )
    return { content: [{ type: 'text', text: `Sent. message_ids: ${ids.join(', ')}` }] }
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
    const recent = messageHistory.slice(-limit)
    const lines = recent.map(m =>
      `[${m.ts}] ${m.user} (id:${m.message_id}): ${m.text}`
    )
    return { content: [{ type: 'text', text: lines.join('\n') || 'No messages yet.' }] }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
})

// ── message history (in-memory, last 100) ────────────────────────────────────

type TgMessage = {
  message_id: number
  user: string
  text: string
  ts: string
}

const messageHistory: TgMessage[] = []

// ── Queue file reader (routing bot writes here, we consume) ──────────────────
// This avoids conflicts with the routing bot both polling getUpdates.

const QUEUE_FILE = `/tmp/tg-queue-${THREAD_ID}.jsonl`

type QueueEntry = {
  text: string
  user: string
  message_id: number
  thread_id: number
  chat_id: number
  ts: number
  photo_path?: string
}

async function poll(): Promise<void> {
  // Track file position so we only read new lines
  let filePos = 0

  // If queue file exists, start at end (don't replay old messages)
  try {
    const stat = Bun.file(QUEUE_FILE)
    if (await stat.exists()) {
      filePos = (await stat.arrayBuffer()).byteLength
    }
  } catch {}

  while (true) {
    try {
      const file = Bun.file(QUEUE_FILE)
      if (!(await file.exists())) { await Bun.sleep(500); continue }

      const buf   = await file.arrayBuffer()
      const total = buf.byteLength

      if (total > filePos) {
        const newBytes = new Uint8Array(buf, filePos, total - filePos)
        const newText  = new TextDecoder().decode(newBytes)
        filePos = total

        for (const line of newText.split('\n')) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line) as QueueEntry
            const { text, user, message_id, ts, photo_path } = entry
            const isoTs = new Date(ts * 1000).toISOString()

            messageHistory.push({ message_id, user, text, ts: isoTs })
            if (messageHistory.length > 100) messageHistory.shift()

            process.stderr.write(`[telegram] sending notification: ${user}: ${text}\n`)
            Bun.write('/tmp/mcp-debug.log', `[${new Date().toISOString()}] sending notification: ${user}: ${text}\n`, { append: true })

            void mcp.notification({
              method: 'notifications/claude/channel',
              params: {
                content: text,
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

            process.stderr.write(`[telegram] notification sent: ${user}: ${text}\n`)
            Bun.write('/tmp/mcp-debug.log', `[${new Date().toISOString()}] notification sent OK\n`, { append: true })
          } catch (e) {
            process.stderr.write(`[telegram] parse error: ${e}\n`)
          }
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
