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
import { buildMessageThreadParams, buildTypingThreadParams } from './threading.ts'

// ── config ────────────────────────────────────────────────────────────────────

// Load env: /root/relay/.env is canonical (read first so it wins).
// ~/.claude/channels/telegram/.env fills in anything still missing after.
const ENV_FILES = [
  '/root/relay/.env',
  join(homedir(), '.claude', 'channels', 'telegram', '.env'),
]

for (const ENV_FILE of ENV_FILES) {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.+)$/)   // require non-empty value
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {}
}

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID ?? process.env.GROUP_CHAT_ID
const THREAD_ID = process.env.TELEGRAM_THREAD_ID ? parseInt(process.env.TELEGRAM_THREAD_ID) : undefined

if (!TOKEN || !CHAT_ID || !THREAD_ID) {
  process.stderr.write(
    `telegram channel: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID required\n` +
    `  set in ${ENV_FILES[0]} or as environment variables\n`
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

// Forward message to Discord if a discord-ctx file exists for this thread
async function forwardToDiscord(threadId: number | undefined, text: string): Promise<void> {
  if (!threadId) return
  const DISCORD_BRIDGE = process.env.DISCORD_BRIDGE_URL || 'http://discord-bridge:9102'
  try {
    const ctxFile = `/tmp/discord-ctx-${threadId}`
    const { existsSync } = await import('fs')
    if (!existsSync(ctxFile)) return // no Discord context for this thread
    await fetch(`${DISCORD_BRIDGE}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, text }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (_) {
    // Discord forward is best-effort — never block Telegram response
  }
}

// Forward message to WhatsApp if a whatsapp-ctx file exists for this thread
async function forwardToWhatsApp(threadId: number | undefined, text: string): Promise<void> {
  if (!threadId) return
  const WA_BRIDGE = process.env.WA_BRIDGE_URL || 'http://whatsapp-bridge:9103'
  try {
    const ctxFile = `/tmp/whatsapp-ctx-${threadId}`
    const { existsSync } = await import('fs')
    if (!existsSync(ctxFile)) return
    await fetch(`${WA_BRIDGE}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, text }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (_) {
    // WhatsApp forward is best-effort
  }
}

// Forward message to Slack if a slack-ctx file exists for this thread
async function forwardToSlack(threadId: number | undefined, text: string): Promise<void> {
  if (!threadId) return
  const SLACK_BRIDGE = process.env.SLACK_BRIDGE_URL || 'http://slack-bridge:9104'
  try {
    const ctxFile = `/tmp/slack-ctx-${threadId}`
    const { existsSync } = await import('fs')
    if (!existsSync(ctxFile)) return // no Slack context for this thread
    await fetch(`${SLACK_BRIDGE}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, text }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (_) {
    // Slack forward is best-effort — never block Telegram response
  }
}

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
      text: chunk,
      parse_mode: 'HTML',
      ...buildMessageThreadParams(THREAD_ID),
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

async function sendMessageStreaming(text: string, replyTo?: number, buttons?: string[][]): Promise<number[]> {
  text = autoCode(text)
  // Send initial placeholder
  const body: Record<string, unknown> = {
    chat_id: CHAT_ID,
    text: '▍',
    parse_mode: 'HTML',
    ...buildMessageThreadParams(THREAD_ID),
  }
  if (replyTo) body.reply_to_message_id = replyTo
  const initRes = await tg('sendMessage', body) as { ok: boolean; result: { message_id: number } }
  if (!initRes.ok) return []
  const msgId = initRes.result.message_id

  // Stream word by word
  const words = text.split(/(\s+)/)
  let accumulated = ''
  let lastEditLen = 0
  const CHUNK_SIZE = 12  // edit every N words — keep well under Telegram's 1 edit/sec limit
  let wordCount = 0

  for (const word of words) {
    accumulated += word
    if (/\S/.test(word)) wordCount++
    // Edit periodically, not every single word (to avoid rate limits)
    if (wordCount % CHUNK_SIZE === 0 && accumulated.length > lastEditLen) {
      // Strip HTML tags for intermediate edits — partial HTML breaks Telegram parse_mode:HTML
      // (e.g. "<b>word" with unclosed tag causes ok:false and message stops updating)
      const plainPreview = accumulated.replace(/<[^>]+>/g, '') + ' ▍'
      const editRes = await tg('editMessageText', {
        chat_id: CHAT_ID,
        message_id: msgId,
        text: plainPreview,
      }) as { ok: boolean; parameters?: { retry_after?: number }; description?: string }
      if (!editRes.ok) {
        process.stderr.write(`[telegram] streaming edit failed: ${editRes.description}\n`)
        if (editRes.parameters?.retry_after) {
          await Bun.sleep((editRes.parameters.retry_after + 1) * 1000)
          await tg('editMessageText', { chat_id: CHAT_ID, message_id: msgId, text: plainPreview })
        }
        // On other errors (e.g. "message is not modified"), just continue — not fatal
      }
      lastEditLen = accumulated.length
      await Bun.sleep(1200)  // stay safely under Telegram's ~1 edit/sec per message limit
    }
  }

  // Final edit with full text (no cursor) + buttons
  const replyMarkup = buttons ? {
    inline_keyboard: buttons.map(row =>
      row.map(label => ({ text: label, callback_data: `btn:${THREAD_ID}:${label}` }))
    ),
  } : undefined

  const finalBody: Record<string, unknown> = {
    chat_id: CHAT_ID,
    message_id: msgId,
    text: accumulated,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }
  const finalRes = await tg('editMessageText', finalBody) as { ok: boolean; description?: string }
  if (!finalRes.ok) {
    // HTML parse failed — fall back to plain text so user sees the full message
    process.stderr.write(`[telegram] final HTML edit failed (${finalRes.description}) — retrying as plain text\n`)
    const plain = accumulated.replace(/<[^>]+>/g, '')
    await tg('editMessageText', {
      chat_id: CHAT_ID,
      message_id: msgId,
      text: plain,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
  }

  return [msgId]
}

async function sendTyping(): Promise<void> {
  await tg('sendChatAction', {
    chat_id: CHAT_ID,
    action: 'typing',
    ...buildTypingThreadParams(THREAD_ID),
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
        required: [],
        properties: {
          text:     { type: 'string',  description: 'Message text (HTML supported)' },
          message:  { type: 'string',  description: 'Alias for text (accepted for compatibility)' },
          reply_to: { type: 'integer', description: 'Optional message_id to reply to' },
          buttons:  {
            type: 'array',
            description: 'Optional inline keyboard buttons. Array of rows, each row is an array of button labels. When clicked, the label is sent back as a message. Example: [["Yes", "No"]] or [["Option A"], ["Option B"]]',
            items: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          streaming: { type: 'boolean', description: 'If true, message appears word-by-word with a typing cursor effect. Default: true.' },
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
      description: 'Get recent messages from this topic (up to last 50 stored). Optionally filter by user, keyword, or time range.',
      inputSchema: {
        type: 'object',
        properties: {
          limit:   { type: 'integer', default: 20, description: 'Max messages to return' },
          user:    { type: 'string',  description: 'Filter by sender name (partial match)' },
          keyword: { type: 'string',  description: 'Filter messages containing this keyword (case-insensitive)' },
          since_secs: { type: 'integer', description: 'Only return messages newer than this many seconds ago (e.g. 3600 = last hour)' },
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
    {
      name: 'send_task',
      description: 'Send a task to another Claude session and get back a task_id. The target session will receive the prompt and should call complete_task when done. Results are automatically routed back to you via your notification channel. Use depends_on for milestone gating — the task will only be sent after all dependency tasks complete.',
      inputSchema: {
        type: 'object',
        required: ['to', 'prompt'],
        properties: {
          to:         { type: 'string', description: 'Target session name (from list_peers)' },
          prompt:     { type: 'string', description: 'Task description / prompt for the target agent' },
          ttl:        { type: 'integer', description: 'Seconds before task expires (default: 600)', default: 600 },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Array of task_ids that must complete before this task is dispatched' },
        },
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a received task as complete and send the result back to the requesting session. Call this when you finish a task you received via send_task.',
      inputSchema: {
        type: 'object',
        required: ['task_id', 'output'],
        properties: {
          task_id: { type: 'string', description: 'The task_id from the task notification you received' },
          output:  { type: 'string', description: 'The result / output to send back to the requester' },
          status:  { type: 'string', description: '"ok" (default) or "error"', enum: ['ok', 'error'] },
        },
      },
    },
    {
      name: 'get_session_context',
      description: 'Read what another session is currently working on. Returns the session\'s memory/session_context.md if available, plus its project path and type.',
      inputSchema: {
        type: 'object',
        required: ['session'],
        properties: {
          session: { type: 'string', description: 'Target session name (from list_peers)' },
        },
      },
    },
    {
      name: 'broadcast',
      description: 'Send a message to ALL other active sessions at once. Useful for announcements, status updates, or requesting help from any available agent.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Message to broadcast to all sessions' },
        },
      },
    },
    {
      name: 'knowledge_write',
      description: 'Write a finding, decision, or learning to the shared Knowledge Library. All sessions can read from this library. Use tags to categorize entries (e.g. "docker", "auth", "bug-fix"). Entries persist across restarts.',
      inputSchema: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          title:   { type: 'string', description: 'Short title for the knowledge entry' },
          content: { type: 'string', description: 'The finding, decision, or learning to store' },
          tags:    { type: 'array', items: { type: 'string' }, description: 'Tags for categorization (e.g. ["docker", "relay", "bug-fix"])' },
        },
      },
    },
    {
      name: 'knowledge_read',
      description: 'Search the shared Knowledge Library for relevant entries. Returns entries matching the query or tag. All sessions contribute to this library.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term to find relevant entries (searches title, content, tags)' },
          tag:   { type: 'string', description: 'Filter by specific tag' },
          limit: { type: 'integer', description: 'Max entries to return (default: 10)', default: 10 },
        },
      },
    },
    {
      name: 'get_briefing',
      description: 'Get a contextual briefing before starting work on a topic. Searches the shared knowledge base, session memories, and recent activity for anything relevant to the given topic. Call this at the start of a new task to surface useful context.',
      inputSchema: {
        type: 'object',
        required: ['topic'],
        properties: {
          topic: { type: 'string', description: 'The topic or task you are about to work on (e.g. "deploy", "backup", "auth bug")' },
        },
      },
    },
    {
      name: 'auto_dispatch',
      description: 'Automatically find the best session to handle a task based on project path, session type, and recent activity. Then sends the task to that session. Like send_task but with automatic routing.',
      inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt:        { type: 'string', description: 'Task description' },
          prefer_type:   { type: 'string', description: 'Preferred session type: "claude", "codex", or "copilot"', enum: ['claude', 'codex', 'copilot'] },
          prefer_project: { type: 'string', description: 'Preferred project path substring (e.g. "relay", "openclaw")' },
          prefer_skills:  { type: 'array', items: { type: 'string' }, description: 'Preferred skills (e.g. ["docker", "python"]). If omitted, skills are auto-detected from prompt.' },
          ttl:           { type: 'integer', description: 'Seconds before task expires (default: 600)', default: 600 },
        },
      },
    },
    {
      name: 'delegate_task',
      description: 'Delegate a task to a specific session as an orchestrator. Queues the task into the target session\'s message queue with orchestrator priority. If expect_result is true, creates a result file the target can write to when done.',
      inputSchema: {
        type: 'object',
        required: ['target_session', 'task'],
        properties: {
          target_session: { type: 'string', description: 'Target session name (from list_peers)' },
          task:           { type: 'string', description: 'Task description / prompt to send to the target session' },
          expect_result:  { type: 'boolean', description: 'If true, creates a pending-result file the target can write to when done', default: false },
        },
      },
    },
    {
      name: 'await_result',
      description: 'Wait for a delegated task to complete and return its result. Blocks until the result is available or timeout is reached. Use after delegate_task to get the output synchronously.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id:      { type: 'string',  description: 'The task_id returned by send_task or delegate_task' },
          timeout_secs: { type: 'integer', description: 'Max seconds to wait (default: 120)', default: 120 },
        },
      },
    },
    {
      name: 'send_code',
      description: 'Send a properly formatted code block to Telegram. The code will have a native tap-to-copy button in Telegram. Use this instead of wrapping code manually in <pre> tags.',
      inputSchema: {
        type: 'object',
        required: ['code'],
        properties: {
          code:     { type: 'string', description: 'The code to send' },
          language: { type: 'string', description: 'Optional language for syntax hint (e.g. "bash", "python", "javascript")' },
          caption:  { type: 'string', description: 'Optional caption text to show above the code block' },
        },
      },
    },
    {
      name: 'memory_read',
      description: 'Read from the session memory store. If key is given, returns that value. If no key, returns all keys as JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Optional key to read. If omitted, returns all keys.' },
        },
      },
    },
    {
      name: 'memory_search',
      description: 'Search across ALL sessions\' memory stores for a keyword or value. Useful for finding context from other sessions, e.g. "what did the relay session remember about backups?"',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search term to look for in any session\'s memory keys or values' },
        },
      },
    },
    {
      name: 'read_peer_memory',
      description: 'Read the memory store of another session by name. More targeted than memory_search — use when you know which session you want to read from.',
      inputSchema: {
        type: 'object',
        required: ['session'],
        properties: {
          session: { type: 'string', description: 'Session name (e.g. "relay", "ha", "golem")' },
          key:     { type: 'string', description: 'Optional: specific key to read. If omitted, returns all keys.' },
        },
      },
    },
    {
      name: 'send_diff',
      description: 'Send a git diff to Telegram. Parses the diff for stats (files changed, insertions, deletions) and sends a summary followed by the diff content.',
      inputSchema: {
        type: 'object',
        required: ['diff'],
        properties: {
          diff:    { type: 'string', description: 'Git diff output (e.g. from git diff HEAD or git diff --stat)' },
          caption: { type: 'string', description: 'Optional caption/title for the diff' },
        },
      },
    },
    {
      name: 'notify',
      description: 'Send a direct notification message to the owner\'s Telegram user (DM, not the group topic). Use for critical alerts, completed background tasks, or anything that needs immediate attention outside the normal conversation thread. Requires NOTIFY_USER_ID to be set in env.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text:   { type: 'string',  description: 'Notification message text (HTML supported)' },
          urgent: { type: 'boolean', description: 'If true, sends with notification sound (default). If false, sends silently.' },
        },
      },
    },
    {
      name: 'send_form',
      description: 'Send a multi-step interactive form step to the user via Telegram inline buttons. Persists form state so you can track which step the user is on. Use this for multi-step workflows like deploy confirmations, config wizards, etc. After calling send_form, when the user clicks a button, call get_form_state to retrieve context, update_form_state to advance the step, and send_form again for the next step. Call clear_form when done.',
      inputSchema: {
        type: 'object',
        required: ['form_id', 'step', 'question', 'options'],
        properties: {
          form_id:  { type: 'string',  description: 'Unique identifier for this form (e.g. "deploy", "confirm-restart")' },
          step:     { type: 'integer', description: 'Current step number (1-based)' },
          question: { type: 'string',  description: 'The question or prompt to show the user' },
          options:  { type: 'array', items: { type: 'string' }, description: 'Button labels for the user to choose from' },
          context:  { type: 'object',  description: 'Optional state/context to persist with this form step (e.g. {"env": "production"})' },
        },
      },
    },
    {
      name: 'get_form_state',
      description: 'Retrieve the current state of a multi-step form. Returns the form_id, current step, and any context stored by send_form or update_form_state.',
      inputSchema: {
        type: 'object',
        required: ['form_id'],
        properties: {
          form_id: { type: 'string', description: 'The form identifier to look up' },
        },
      },
    },
    {
      name: 'update_form_state',
      description: 'Update the state of a multi-step form (advance the step and/or update context). Call this after the user responds to a form step, before sending the next step.',
      inputSchema: {
        type: 'object',
        required: ['form_id'],
        properties: {
          form_id: { type: 'string',  description: 'The form identifier to update' },
          step:    { type: 'integer', description: 'New step number' },
          context: { type: 'object',  description: 'Updated context/state object (merged with existing context)' },
        },
      },
    },
    {
      name: 'clear_form',
      description: 'Delete a form\'s state file. Call this when the form flow is complete (user confirmed, cancelled, or timed out).',
      inputSchema: {
        type: 'object',
        required: ['form_id'],
        properties: {
          form_id: { type: 'string', description: 'The form identifier to clear' },
        },
      },
    },
    // ── Feature 3: Voice TTS ──────────────────────────────────────────────────
    {
      name: 'send_voice',
      description: 'Convert text to speech using OpenAI TTS and send as a voice message in Telegram. Requires OPENAI_API_KEY. Falls back to text if not available.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text:  { type: 'string', description: 'Text to convert to speech (max ~4096 chars)' },
          voice: { type: 'string', description: 'Voice to use: alloy, echo, fable, onyx, nova, shimmer (default: alloy)', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
        },
      },
    },
    // ── Feature 5: Agent-to-agent task marketplace ───────────────────────────
    {
      name: 'publish_task',
      description: 'Publish a task to the agent marketplace. Other agents can claim it based on their skills.',
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task:             { type: 'string',  description: 'Task description' },
          required_skills:  { type: 'array', items: { type: 'string' }, description: 'Skills required to perform the task (e.g. ["docker", "python"])' },
          deadline_minutes: { type: 'number',  description: 'Minutes until the task expires (default: 60)', default: 60 },
        },
      },
    },
    {
      name: 'claim_task',
      description: 'Claim a task from the marketplace. Notifies the publishing session.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', description: 'Task ID to claim (from list_available_tasks or publish_task)' },
        },
      },
    },
    {
      name: 'list_available_tasks',
      description: 'List unclaimed, non-expired tasks in the marketplace that match this session\'s skills.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    // ── Feature: Agent state machine ─────────────────────────────────────────
    {
      name: 'set_agent_state',
      description: 'Set this agent\'s current operational state. Call this to report what you are doing so the /agents dashboard and other agents can see your status. States: idle (waiting for work), busy (actively working), awaiting (waiting for another agent or resource), done (task complete, returning to idle).',
      inputSchema: {
        type: 'object',
        required: ['state'],
        properties: {
          state:   { type: 'string', description: 'Agent state', enum: ['idle', 'busy', 'awaiting', 'done'] },
          task:    { type: 'string', description: 'Brief description of current task (e.g. "running tests", "writing migration")' },
          blocked_by: { type: 'string', description: 'If state=awaiting, what/who this agent is waiting for' },
        },
      },
    },
    // ── Feature: Orchestrator (split_task) ───────────────────────────────────
    {
      name: 'split_task',
      description: 'Fan out a task to multiple sessions in parallel and aggregate all results. The orchestrator sends subtasks to each target session, waits for all to complete (or timeout), and returns a combined result. Best used when a large task can be parallelized across agents.',
      inputSchema: {
        type: 'object',
        required: ['subtasks'],
        properties: {
          subtasks: {
            type: 'array',
            description: 'List of subtasks to fan out. Each has a target session and prompt.',
            items: {
              type: 'object',
              required: ['session', 'prompt'],
              properties: {
                session: { type: 'string', description: 'Target session name' },
                prompt:  { type: 'string', description: 'Task prompt for this session' },
              },
            },
          },
          timeout_secs: { type: 'integer', description: 'Max seconds to wait for ALL tasks (default: 180)', default: 180 },
          context:      { type: 'string',  description: 'Optional shared context prepended to every subtask prompt' },
        },
      },
    },
    // ── Feature: Ephemeral agents ─────────────────────────────────────────────
    {
      name: 'spawn_agent',
      description: 'Spawn a temporary one-shot agent to handle a task. The agent runs in an isolated container, completes the task, reports back, and is automatically cleaned up. Use for tasks that need a fresh context, a different working directory, or should not affect the current session.',
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task:     { type: 'string',  description: 'Task for the ephemeral agent to perform' },
          workdir:  { type: 'string',  description: 'Working directory for the agent (default: /relay)' },
          wait:     { type: 'boolean', description: 'If true, wait for the agent to complete and return the result (default: false — fire and forget)', default: false },
          timeout_secs: { type: 'integer', description: 'Max seconds to wait if wait=true (default: 300)', default: 300 },
        },
      },
    },
    // ── New tools ─────────────────────────────────────────────────────────────
    {
      name: 'schedule_message',
      description: 'Schedule a message or reminder to be delivered to yourself (Claude) after a delay. Useful for time-based reminders, follow-ups, or deferred tasks. The message will arrive as a system force notification.',
      inputSchema: {
        type: 'object',
        required: ['text', 'delay_secs'],
        properties: {
          text:       { type: 'string',  description: 'Message text to deliver after the delay' },
          delay_secs: { type: 'integer', description: 'Seconds from now to deliver the message (e.g. 300 = 5 minutes)' },
          label:      { type: 'string',  description: 'Optional label shown in the delivered message (e.g. "reminder", "follow-up")' },
        },
      },
    },
    {
      name: 'get_metrics',
      description: 'Get runtime metrics for a session: token usage, cost, uptime, message counts, error log. Pulls from token-stats and relay-api data.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session name to query (default: this session)' },
          period:  { type: 'string', description: 'Time period: "today", "1h", "5m" (default: "today")', enum: ['today', '1h', '5m'] },
        },
      },
    },
    {
      name: 'memory_write',
      description: 'Write or update a key-value pair in the session memory store. Use this to persist structured data across conversations. Better than knowledge_write for simple key→value data. Supports optional TTL.',
      inputSchema: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key:      { type: 'string',  description: 'The key to store the value under' },
          value:    { type: 'string',  description: 'The value to store (any string, including JSON)' },
          ttl_secs: { type: 'integer', description: 'Optional TTL in seconds. After this time, the key is considered expired and will be omitted from reads. Default: no expiry.' },
        },
      },
    },
    {
      name: 'ping_session',
      description: 'Check if another session is alive by injecting a ping into its queue and checking for recent activity. Returns response time or "no response" if session appears stuck.',
      inputSchema: {
        type: 'object',
        required: ['session'],
        properties: {
          session: { type: 'string', description: 'Session name to ping (e.g. "ha", "relay")' },
          timeout_secs: { type: 'integer', description: 'Max seconds to wait for response (default: 20)', default: 20 },
        },
      },
    },
    {
      name: 'get_logs',
      description: 'Get recent logs from a Docker service or log file. Useful for debugging sessions and services.',
      inputSchema: {
        type: 'object',
        required: ['service'],
        properties: {
          service: { type: 'string', description: 'Service/container name (e.g. "relay-api", "relay-session-ha") or log file path' },
          lines:   { type: 'integer', description: 'Number of lines to return (default: 30)', default: 30 },
        },
      },
    },
    {
      name: 'http_get',
      description: 'Make an HTTP GET request and return the response. Useful for checking internal APIs, health endpoints, or external services.',
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: {
          url:     { type: 'string', description: 'URL to fetch' },
          headers: { type: 'object', description: 'Optional headers as key-value pairs', additionalProperties: { type: 'string' } },
          timeout_secs: { type: 'integer', description: 'Timeout in seconds (default: 10)', default: 10 },
        },
      },
    },
  ],
}))

// Forward reference — poll() sets this; CallTool handler updates it
let _updateActivity: (() => void) | null = null

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  // Confirm delivery when Claude calls any messaging-related tool — proves it's actively responding.
  // fetch_messages, send_message, typing, react, send_file all indicate the session is alive and processing.
  // Update activity on ANY tool call — proves Claude is alive and processing
  if (_updateActivity) _updateActivity()

  if (name === 'send_message') {
    // Accept 'message' as alias for 'text' — Claude sometimes uses wrong param name
    let text = String(args?.text ?? args?.message ?? '')

    // Append response time if a start timestamp file exists for this thread
    try {
      const startFile = `/tmp/relay-msg-start-${THREAD_ID}`
      const { existsSync, readFileSync, unlinkSync } = await import('fs')
      if (existsSync(startFile)) {
        const startMs = parseInt(readFileSync(startFile, 'utf8').trim(), 10)
        if (!isNaN(startMs) && startMs > 0) {
          const elapsedSec = Math.round((Date.now() - startMs) / 1000)
          if (elapsedSec >= 0) {
            text = text + `\n<i>⏱ ${elapsedSec}s</i>`
          }
          unlinkSync(startFile) // consume it — next message gets fresh timing
        }
      }
    } catch (_) { /* best-effort */ }
    // Claude sometimes passes buttons as a JSON string instead of array — parse it
    const rawButtons = args?.buttons
    const buttons: string[][] | undefined = typeof rawButtons === 'string'
      ? (() => { try { return JSON.parse(rawButtons) } catch { return undefined } })()
      : rawButtons as string[][] | undefined
    const streaming = args?.streaming !== undefined ? Boolean(args.streaming) : false  // default: streaming OFF (too many rate-limit/HTML failures)
    // Negative reply_to IDs are synthetic (e.g. callback buttons) — not valid Telegram message IDs
    const replyTo = (args?.reply_to as number | undefined)
    const validReplyTo = replyTo && replyTo > 0 ? replyTo : undefined
    const ids = streaming
      ? await sendMessageStreaming(text, validReplyTo, buttons)
      : await sendMessage(text, validReplyTo, buttons)
    // Write response timestamp so the relay bot knows Claude replied
    void Bun.write(`/tmp/tg-last-sent-${THREAD_ID}`, String(Date.now() / 1000))
    // Clear crash-alert flag so the watchdog can send a fresh alert after the next silence period
    try { const { unlinkSync, existsSync } = await import('fs'); const f = `/tmp/tg-crash-alerted-${THREAD_ID}`; if (existsSync(f)) unlinkSync(f) } catch (_) { /* best-effort */ }

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

    if (ids.length === 0) {
      return { content: [{ type: 'text', text: `ERROR: message failed to send. text param was: "${text.slice(0, 100)}". Call send_message again with correct params (use 'text' not 'message').` }], isError: true }
    }

    // Forward to Discord/WhatsApp/Slack if context exists for this thread
    void forwardToDiscord(THREAD_ID, text)
    void forwardToWhatsApp(THREAD_ID, text)
    void forwardToSlack(THREAD_ID, text)

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
      const threadParams = buildMessageThreadParams(THREAD_ID)
      if (threadParams?.message_thread_id != null) {
        form.append('message_thread_id', String(threadParams.message_thread_id))
      }
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
    const limit     = Number(args?.limit ?? 20)
    const userFilter    = args?.user    ? String(args.user).toLowerCase()    : null
    const keywordFilter = args?.keyword ? String(args.keyword).toLowerCase() : null
    const sinceSecs     = args?.since_secs ? Number(args.since_secs) : null

    let recent = dbRecent(Math.min(limit * 5, 200))  // fetch extra to allow for filtering

    if (userFilter)    recent = recent.filter(m => m.user.toLowerCase().includes(userFilter))
    if (keywordFilter) recent = recent.filter(m => m.text.toLowerCase().includes(keywordFilter))
    if (sinceSecs) {
      const cutoffIso = new Date(Date.now() - sinceSecs * 1000).toISOString()
      recent = recent.filter(m => m.ts >= cutoffIso)
    }

    recent = recent.slice(-limit)  // take most recent N after filtering
    const lines = recent.map(m => `[${m.ts}] ${m.user} (id:${m.message_id}): ${m.text}`)
    return { content: [{ type: 'text', text: lines.join('\n') || 'No messages matching filter.' }] }
  }

  if (name === 'list_peers') {
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string; path?: string; type?: string; skills?: string[]; group?: string }> =
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
        const type = s.type ?? 'claude'
        const path = s.path ?? ''
        const group = s.group ?? ''
        const skills = s.skills?.join(',') ?? ''
        lines.push(`${s.session} [${type}] (${host}) ${path} — group:${group} skills:[${skills}] — last active: ${lastActive}`)
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

  if (name === 'send_task') {
    const targetSession = String(args?.to ?? '')
    const prompt        = String(args?.prompt ?? '')
    const ttl           = Number(args?.ttl ?? 600)
    const dependsOn     = (args?.depends_on as string[] | undefined) ?? []
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const target = sessions.find(s => s.session === targetSession)
      if (!target) return { content: [{ type: 'text', text: `Session '${targetSession}' not found. Use list_peers to see available sessions.` }] }

      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
      const taskId   = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // Check dependencies — if any are not complete, queue the task as "waiting"
      const TASKS_FILE = '/tmp/agent-tasks.json'
      let tasks: Record<string, any> = {}
      try {
        const f = Bun.file(TASKS_FILE)
        if (await f.exists()) tasks = JSON.parse(await f.text())
      } catch {}

      const pendingDeps = dependsOn.filter(depId => {
        const dep = tasks[depId]
        return !dep || dep.status !== 'complete'
      })

      const isBlocked = pendingDeps.length > 0

      tasks[taskId] = {
        from:        selfName,
        from_thread: THREAD_ID,
        from_host:   null,
        to:          targetSession,
        to_thread:   target.thread_id,
        created:     Date.now() / 1000,
        ttl,
        status:      isBlocked ? 'waiting' : 'pending',
        depends_on:  dependsOn.length > 0 ? dependsOn : undefined,
        prompt,
      }
      await Bun.write(TASKS_FILE, JSON.stringify(tasks, null, 2))

      if (isBlocked) {
        return { content: [{ type: 'text', text: `Task ${taskId} created but WAITING on dependencies: ${pendingDeps.join(', ')}. It will be dispatched when they complete.` }] }
      }

      // Write task message into target's queue
      const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
      const entry = JSON.stringify({
        text:       `[Task from ${selfName} | task_id:${taskId}]\n${prompt}`,
        user:       `agent:${selfName}`,
        message_id: -Date.now(),
        ts:         Date.now() / 1000,
        force:      true,
        bus: { type: 'task', id: taskId, from: selfName, from_thread: THREAD_ID, to: targetSession, prompt, ttl },
      })

      if (target.host) {
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

      void logToPeersTopic(selfName, targetSession, `[task:${taskId}] ${prompt}`)
      return { content: [{ type: 'text', text: `Task sent to '${targetSession}'. task_id: ${taskId}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error sending task: ${e}` }] }
    }
  }

  if (name === 'complete_task') {
    const taskId = String(args?.task_id ?? '')
    const output = String(args?.output ?? '')
    const status = String(args?.status ?? 'ok')
    try {
      const TASKS_FILE = '/tmp/agent-tasks.json'
      const f = Bun.file(TASKS_FILE)
      if (!(await f.exists())) return { content: [{ type: 'text', text: `No pending tasks found.` }] }

      const tasks = JSON.parse(await f.text()) as Record<string, {
        from: string; from_thread: number; to: string; status: string
      }>
      const task = tasks[taskId]
      if (!task) return { content: [{ type: 'text', text: `Task '${taskId}' not found.` }] }
      if (task.status !== 'pending') return { content: [{ type: 'text', text: `Task '${taskId}' is already ${task.status}.` }] }

      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`

      // Route result back to requester's queue
      const queueFile = `/tmp/tg-queue-${task.from_thread}.jsonl`
      const entry = JSON.stringify({
        text:       `[Result from ${selfName} | task_id:${taskId} | status:${status}]\n${output}`,
        user:       `agent:${selfName}`,
        message_id: -Date.now(),
        ts:         Date.now() / 1000,
        force:      true,
        bus: { type: 'result', id: `result-${Date.now()}`, from: selfName, to: task.from, reply_to: taskId, status, output },
      })
      await Bun.write(queueFile, entry + '\n', { append: true })

      // Update task status
      tasks[taskId].status = status === 'error' ? 'error' : 'complete'
      await Bun.write(TASKS_FILE, JSON.stringify(tasks, null, 2))

      // Write result file for await_result polling
      const resultFile = `/tmp/relay-task-result-${taskId}.json`
      await Bun.write(resultFile, JSON.stringify({
        status,
        output,
        from: selfName,
        completed_at: Date.now() / 1000,
      }))

      // Milestone gating: dispatch any waiting tasks whose dependencies are now met
      const dispatched: string[] = []
      for (const [tid, t] of Object.entries(tasks) as [string, any][]) {
        if (t.status !== 'waiting' || !t.depends_on) continue
        const stillWaiting = t.depends_on.filter((depId: string) => {
          const dep = tasks[depId]
          return !dep || dep.status !== 'complete'
        })
        if (stillWaiting.length === 0) {
          // All dependencies met — dispatch the task now
          tasks[tid].status = 'pending'
          const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
          const allSessions = JSON.parse(readFileSync(sessionsPath, 'utf8'))
          const targetSess = allSessions.find((s: any) => s.session === t.to)
          if (targetSess) {
            const dispatchEntry = JSON.stringify({
              text: `[Task from ${t.from} | task_id:${tid}]\n${t.prompt}`,
              user: `agent:${t.from}`,
              message_id: -Date.now(),
              ts: Date.now() / 1000,
              force: true,
              bus: { type: 'task', id: tid, from: t.from, from_thread: t.from_thread, to: t.to, prompt: t.prompt, ttl: t.ttl },
            })
            const dispatchQueueFile = `/tmp/tg-queue-${targetSess.thread_id}.jsonl`
            await Bun.write(dispatchQueueFile, dispatchEntry + '\n', { append: true })
            dispatched.push(tid)
          }
        }
      }
      if (dispatched.length > 0) await Bun.write(TASKS_FILE, JSON.stringify(tasks, null, 2))

      void logToPeersTopic(selfName, task.from, `[result:${taskId}] ${status}: ${output.slice(0, 200)}`)
      const dispatchMsg = dispatched.length > 0 ? ` Unblocked tasks: ${dispatched.join(', ')}` : ''
      return { content: [{ type: 'text', text: `Result sent back to '${task.from}'. Task ${taskId} marked complete.${dispatchMsg}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error completing task: ${e}` }] }
    }
  }

  if (name === 'get_session_context') {
    const targetSession = String(args?.session ?? '')
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string; path?: string; type?: string; skills?: string[]; group?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const target = sessions.find(s => s.session === targetSession)
      if (!target) return { content: [{ type: 'text', text: `Session '${targetSession}' not found. Use list_peers to see available sessions.` }] }

      const info: string[] = [
        `Session: ${target.session}`,
        `Type: ${target.type ?? 'claude'}`,
        `Path: ${target.path ?? 'unknown'}`,
        `Host: ${target.host ?? 'local'}`,
      ]

      // Try to read the session's memory/session_context.md
      const contextPaths = [
        `${target.path ?? '/root'}/.claude/memory/session_context.md`,
        `/root/.claude/projects/-${(target.path ?? '/root').replace(/\//g, '-')}/memory/session_context.md`,
      ]
      let context = ''
      for (const cp of contextPaths) {
        try {
          if (target.host) {
            const proc = Bun.spawn(
              ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=3',
               target.host, `cat ${cp} 2>/dev/null`]
            )
            const out = await new Response(proc.stdout).text()
            if (out.trim()) { context = out.trim(); break }
          } else {
            const f = Bun.file(cp)
            if (await f.exists()) { context = (await f.text()).trim(); break }
          }
        } catch {}
      }

      // Also check auto-memory session_context
      if (!context) {
        const autoMemoryPath = `/root/.claude/projects/-${(target.path ?? '/root').replace(/\//g, '-')}/memory/session_context.md`
        try {
          const f = Bun.file(autoMemoryPath)
          if (await f.exists()) context = (await f.text()).trim()
        } catch {}
      }

      if (context) {
        info.push('', '--- Session Context ---', context)
      } else {
        info.push('', 'No session context available.')
      }

      // Also read session summary if it exists
      const summaryFile = `/tmp/session-summary-${target.thread_id}.md`
      try {
        const sf = Bun.file(summaryFile)
        if (await sf.exists()) {
          const summary = (await sf.text()).trim()
          if (summary) info.push('', '--- Last Session Summary ---', summary)
        }
      } catch {}

      // Also read last 5 messages from queue
      try {
        const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
        const qf = Bun.file(queueFile)
        if (await qf.exists()) {
          const lines = (await qf.text()).trim().split('\n').filter(l => l.trim())
          const recent = lines.slice(-5).map(l => {
            try {
              const m = JSON.parse(l)
              return `[${m.user ?? 'unknown'}]: ${(m.text ?? '').slice(0, 120)}`
            } catch { return l.slice(0, 120) }
          })
          if (recent.length > 0) info.push('', '--- Last 5 Messages ---', ...recent)
        }
      } catch {}

      return { content: [{ type: 'text', text: info.join('\n') }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading session context: ${e}` }] }
    }
  }

  if (name === 'broadcast') {
    const text = String(args?.text ?? '')
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
      const sent: string[] = []
      const failed: string[] = []

      for (const target of sessions) {
        if (target.thread_id === THREAD_ID) continue  // skip self
        const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
        const entry = JSON.stringify({
          text: `[Broadcast from ${selfName}]\n${text}`,
          user: `peer:${selfName}`,
          message_id: -Date.now(),
          thread_id: target.thread_id,
          ts: Date.now() / 1000,
          force: true,
        })

        try {
          if (target.host) {
            const proc = Bun.spawn(
              ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
               target.host, `cat >> ${queueFile}`],
              { stdin: new TextEncoder().encode(entry + '\n') }
            )
            await proc.exited
            if (proc.exitCode !== 0) throw new Error(`SSH exit ${proc.exitCode}`)
          } else {
            await Bun.write(queueFile, entry + '\n', { append: true })
          }
          sent.push(target.session)
        } catch {
          failed.push(target.session)
        }
      }

      void logToPeersTopic(selfName, 'broadcast', text.slice(0, 200))
      const result = `Broadcast sent to ${sent.length} sessions: ${sent.join(', ')}`
      return { content: [{ type: 'text', text: failed.length ? `${result}\nFailed: ${failed.join(', ')}` : result }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error broadcasting: ${e}` }] }
    }
  }

  // ── Knowledge Library ─────────────────────────────────────────────────────

  const KNOWLEDGE_FILE = '/root/.claude/relay-knowledge.json'  // persists across container restarts

  if (name === 'knowledge_write') {
    const title   = String(args?.title ?? '')
    const content = String(args?.content ?? '')
    const tags    = (args?.tags as string[]) ?? []
    try {
      let entries: Array<{ id: string; title: string; content: string; tags: string[]; author: string; ts: number }> = []
      try {
        const f = Bun.file(KNOWLEDGE_FILE)
        if (await f.exists()) entries = JSON.parse(await f.text())
      } catch {}

      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
      const entry = {
        id: `k-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title,
        content,
        tags,
        author: selfName,
        ts: Date.now() / 1000,
      }
      entries.push(entry)

      // Keep last 200 entries
      if (entries.length > 200) entries = entries.slice(-200)
      await Bun.write(KNOWLEDGE_FILE, JSON.stringify(entries, null, 2))

      return { content: [{ type: 'text', text: `Knowledge saved: "${title}" (${tags.join(', ') || 'no tags'})` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error writing knowledge: ${e}` }] }
    }
  }

  if (name === 'knowledge_read') {
    const query = String(args?.query ?? '').toLowerCase()
    const tag   = String(args?.tag ?? '').toLowerCase()
    const limit = Number(args?.limit ?? 10)
    try {
      let entries: Array<{ id: string; title: string; content: string; tags: string[]; author: string; ts: number }> = []
      try {
        const f = Bun.file(KNOWLEDGE_FILE)
        if (await f.exists()) entries = JSON.parse(await f.text())
      } catch {}

      let filtered = entries
      if (tag) {
        filtered = filtered.filter(e => e.tags.some(t => t.toLowerCase().includes(tag)))
      }
      if (query) {
        filtered = filtered.filter(e =>
          e.title.toLowerCase().includes(query) ||
          e.content.toLowerCase().includes(query) ||
          e.tags.some(t => t.toLowerCase().includes(query))
        )
      }

      // Most recent first
      filtered = filtered.reverse().slice(0, limit)

      if (filtered.length === 0) {
        return { content: [{ type: 'text', text: 'No matching knowledge entries found.' }] }
      }

      const lines = filtered.map(e => {
        const ago = Math.round((Date.now() / 1000 - e.ts) / 60)
        const timeStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`
        return `[${e.author} ${timeStr}] ${e.title}\nTags: ${e.tags.join(', ') || 'none'}\n${e.content}`
      })
      return { content: [{ type: 'text', text: lines.join('\n---\n') }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading knowledge: ${e}` }] }
    }
  }

  // ── Get Briefing (contextual knowledge surface) ───────────────────────────

  if (name === 'get_briefing') {
    const topic = String(args?.topic ?? '').toLowerCase()
    if (!topic) return { content: [{ type: 'text', text: 'Error: topic is required.' }] }
    try {
      // Search knowledge base
      let knowledgeEntries: Array<{ id: string; title: string; content: string; tags: string[]; author: string; ts: number }> = []
      try {
        const f = Bun.file(KNOWLEDGE_FILE)
        if (await f.exists()) knowledgeEntries = JSON.parse(await f.text())
      } catch {}

      const matchingKnowledge = knowledgeEntries
        .filter(e =>
          e.title.toLowerCase().includes(topic) ||
          e.content.toLowerCase().includes(topic) ||
          e.tags.some(t => t.toLowerCase().includes(topic))
        )
        .reverse()
        .slice(0, 5)

      // Search all session memory files
      const memoryMatches: Array<{ session: string; key: string; value: string }> = []
      const memGlob = new Bun.Glob('/tmp/relay-memory-*.json')
      for await (const filePath of memGlob.scan('/')) {
        if (memoryMatches.length >= 5) break
        try {
          const f = Bun.file(filePath)
          if (!(await f.exists())) continue
          const store: Record<string, string> = JSON.parse(await f.text())
          const sessionName = filePath.replace('/tmp/relay-memory-', '').replace('.json', '')
          for (const [k, v] of Object.entries(store)) {
            if (memoryMatches.length >= 5) break
            if (k.toLowerCase().includes(topic) || String(v).toLowerCase().includes(topic)) {
              memoryMatches.push({ session: sessionName, key: k, value: String(v).substring(0, 200) })
            }
          }
        } catch {}
      }

      const lines: string[] = [`=== Briefing: ${topic} ===`]

      lines.push(`\nFrom Knowledge Library (${matchingKnowledge.length} entries):`)
      if (matchingKnowledge.length > 0) {
        for (const e of matchingKnowledge) {
          const snippet = e.content.length > 150 ? e.content.slice(0, 150) + '…' : e.content
          lines.push(`• [${e.author}] ${e.title}: ${snippet}`)
        }
      } else {
        lines.push('(nothing relevant found)')
      }

      lines.push(`\nFrom Session Memories (${memoryMatches.length} entries):`)
      if (memoryMatches.length > 0) {
        for (const m of memoryMatches) {
          const snippet = m.value.length > 150 ? m.value.slice(0, 150) + '…' : m.value
          lines.push(`• [${m.session}] ${m.key}: ${snippet}`)
        }
      } else {
        lines.push('(nothing relevant found)')
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error getting briefing: ${e}` }] }
    }
  }

  // ── Auto Dispatch ──────────────────────────────────────────────────────────

  if (name === 'auto_dispatch') {
    const prompt       = String(args?.prompt ?? '')
    const preferType   = args?.prefer_type as string | undefined
    const preferProject = args?.prefer_project as string | undefined
    const preferSkills = (args?.prefer_skills as string[] | undefined) ?? []
    const ttl          = Number(args?.ttl ?? 600)
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string; path?: string; type?: string; skills?: string[]; group?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))

      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
      const candidates = sessions.filter(s => s.thread_id !== THREAD_ID)

      // Score each session
      const scored = candidates.map(s => {
        let score = 0
        const type = s.type ?? 'claude'

        // Type preference
        if (preferType && type === preferType) score += 10

        // Project path match
        if (preferProject && s.path?.toLowerCase().includes(preferProject.toLowerCase())) score += 20

        // Check last activity — prefer recently active sessions
        try {
          const raw = readFileSync(`/tmp/tg-last-sent-${s.thread_id}`, 'utf8').trim()
          const ts = parseFloat(raw)
          if (!isNaN(ts)) {
            const agoMin = (Date.now() / 1000 - ts) / 60
            if (agoMin < 5) score += 5        // active in last 5 min
            else if (agoMin < 30) score += 3   // active in last 30 min
            else if (agoMin < 120) score += 1  // active in last 2 hours
          }
        } catch {}

        // Skill match — each matching skill adds points
        if (preferSkills.length > 0 && s.skills) {
          const matched = preferSkills.filter(sk => s.skills!.includes(sk.toLowerCase()))
          score += matched.length * 8  // 8 points per skill match
        }

        // Auto-detect skills from prompt keywords if no prefer_skills given
        if (preferSkills.length === 0 && s.skills) {
          const promptLower = prompt.toLowerCase()
          const matched = s.skills.filter(sk => promptLower.includes(sk))
          score += matched.length * 5  // 5 points per auto-detected match
        }

        // Local sessions preferred over remote (faster)
        if (!s.host) score += 2

        return { session: s, score }
      })

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score)

      if (scored.length === 0) {
        return { content: [{ type: 'text', text: 'No available sessions to dispatch to.' }] }
      }

      const best = scored[0]
      const target = best.session
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // Persist task metadata
      const TASKS_FILE = '/tmp/agent-tasks.json'
      let tasks: Record<string, unknown> = {}
      try {
        const f = Bun.file(TASKS_FILE)
        if (await f.exists()) tasks = JSON.parse(await f.text())
      } catch {}
      tasks[taskId] = {
        from: selfName, from_thread: THREAD_ID, to: target.session,
        to_thread: target.thread_id, created: Date.now() / 1000, ttl, status: 'pending',
      }
      await Bun.write(TASKS_FILE, JSON.stringify(tasks, null, 2))

      // Write to target queue
      const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
      const entry = JSON.stringify({
        text: `[Task from ${selfName} | task_id:${taskId}]\n${prompt}`,
        user: `agent:${selfName}`,
        message_id: -Date.now(),
        ts: Date.now() / 1000,
        force: true,
        bus: { type: 'task', id: taskId, from: selfName, from_thread: THREAD_ID, to: target.session, prompt, ttl },
      })

      if (target.host) {
        const proc = Bun.spawn(
          ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
           target.host, `cat >> ${queueFile}`],
          { stdin: new TextEncoder().encode(entry + '\n') }
        )
        await proc.exited
        if (proc.exitCode !== 0) throw new Error(`SSH exit ${proc.exitCode}`)
      } else {
        await Bun.write(queueFile, entry + '\n', { append: true })
      }

      const type = target.type ?? 'claude'
      const reasons = [
        preferType && type === preferType ? `type=${type}` : null,
        preferProject && target.path?.toLowerCase().includes(preferProject.toLowerCase()) ? `project match` : null,
        !target.host ? 'local' : null,
      ].filter(Boolean).join(', ')

      void logToPeersTopic(selfName, target.session, `[auto-dispatch:${taskId}] ${prompt.slice(0, 200)}`)
      return { content: [{ type: 'text', text: `Auto-dispatched to '${target.session}' [${type}] (score: ${best.score}${reasons ? ', ' + reasons : ''}). task_id: ${taskId}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error auto-dispatching: ${e}` }] }
    }
  }

  // ── Delegate Task (orchestrator) ──────────────────────────────────────────

  if (name === 'delegate_task') {
    const targetSession = String(args?.target_session ?? '')
    const task          = String(args?.task ?? '')
    const expectResult  = Boolean(args?.expect_result ?? false)
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const target = sessions.find(s => s.session === targetSession)
      if (!target) return { content: [{ type: 'text', text: `Session '${targetSession}' not found. Use list_peers to see available sessions.` }] }

      const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`

      const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
      const entry = JSON.stringify({
        text:       `[Delegated task from orchestrator ${selfName}]\n${task}`,
        user:       `orchestrator:${selfName}`,
        message_id: -Date.now(),
        thread_id:  target.thread_id,
        ts:         Date.now() / 1000,
        force:      true,
        via:        'orchestrator',
      })

      if (target.host) {
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

      let resultMsg = `Task delegated to '${targetSession}'.`
      if (expectResult) {
        const resultFile = `/tmp/relay-delegate-result-${target.thread_id}`
        // Write a pending marker so the target knows where to write its result
        await Bun.write(resultFile, JSON.stringify({
          pending: true,
          from: selfName,
          from_thread: THREAD_ID,
          task: task.slice(0, 200),
          created: Date.now() / 1000,
        }))
        resultMsg += ` Result file created at ${resultFile}.`
      }

      void logToPeersTopic(selfName, targetSession, `[delegate] ${task.slice(0, 200)}`)
      return { content: [{ type: 'text', text: resultMsg }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error delegating task: ${e}` }] }
    }
  }

  // ── Await Result (blocking poll for task result) ──────────────────────────

  if (name === 'await_result') {
    const taskId     = String(args?.task_id ?? '')
    const timeoutSec = Number(args?.timeout_secs ?? 120)
    if (!taskId) return { content: [{ type: 'text', text: 'Error: task_id is required.' }] }
    const resultFile = `/tmp/relay-task-result-${taskId}.json`
    const deadline = Date.now() + timeoutSec * 1000
    try {
      while (Date.now() < deadline) {
        const f = Bun.file(resultFile)
        if (await f.exists()) {
          const data = await f.text()
          // Delete the result file after reading
          try { const { unlinkSync } = await import('fs'); unlinkSync(resultFile) } catch (_) {}
          return { content: [{ type: 'text', text: data }] }
        }
        await Bun.sleep(2000)
      }
      return { content: [{ type: 'text', text: `Task result not ready after ${timeoutSec}s` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error waiting for result: ${e}` }] }
    }
  }

  // ── Send Code ─────────────────────────────────────────────────────────────

  if (name === 'send_code') {
    const code     = String(args?.code ?? '')
    const language = args?.language ? String(args.language) : ''
    const caption  = args?.caption  ? String(args.caption)  : ''

    // HTML-escape the code content
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    const langAttr = language ? ` class="${language}"` : ''
    const block = `${caption ? caption + '\n' : ''}<pre><code${langAttr}>${escaped}</code></pre>`

    const ids = await sendMessage(block)
    if (ids.length === 0) {
      return { content: [{ type: 'text', text: 'ERROR: failed to send code block.' }], isError: true }
    }
    return { content: [{ type: 'text', text: `Code block sent (message_id: ${ids.join(', ')})` }] }
  }

  // ── Memory Store (key-value JSON, with optional TTL) ──────────────────────

  const MEMORY_FILE = `/tmp/relay-memory-${THREAD_ID}.json`

  // Internal helper: load memory store, strip expired keys, return clean store
  async function loadMemoryStore(): Promise<Record<string, string>> {
    let raw: Record<string, string | { v: string; exp: number }> = {}
    try {
      const f = Bun.file(MEMORY_FILE)
      if (await f.exists()) raw = JSON.parse(await f.text())
    } catch {}
    const now = Date.now() / 1000
    const clean: Record<string, string> = {}
    for (const [k, entry] of Object.entries(raw)) {
      if (typeof entry === 'string') {
        clean[k] = entry  // legacy plain string
      } else if (typeof entry === 'object' && entry !== null) {
        if (!entry.exp || entry.exp > now) clean[k] = entry.v  // skip expired
      }
    }
    return clean
  }

  if (name === 'memory_write') {
    const key     = String(args?.key ?? '')
    const value   = String(args?.value ?? '')
    const ttlSecs = args?.ttl_secs ? Number(args.ttl_secs) : null
    if (!key) return { content: [{ type: 'text', text: 'Error: key is required.' }] }
    try {
      // Load raw (to preserve TTL metadata on other keys)
      let raw: Record<string, string | { v: string; exp: number }> = {}
      try {
        const f = Bun.file(MEMORY_FILE)
        if (await f.exists()) raw = JSON.parse(await f.text())
      } catch {}
      if (ttlSecs && ttlSecs > 0) {
        raw[key] = { v: value, exp: Math.floor(Date.now() / 1000) + ttlSecs }
      } else {
        raw[key] = value
      }
      await Bun.write(MEMORY_FILE, JSON.stringify(raw, null, 2))
      const expMsg = ttlSecs ? ` (expires in ${ttlSecs}s)` : ''
      return { content: [{ type: 'text', text: `Saved.${expMsg}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error writing memory: ${e}` }] }
    }
  }

  if (name === 'memory_read') {
    const key = args?.key ? String(args.key) : undefined
    try {
      const store = await loadMemoryStore()
      if (key) {
        if (key in store) {
          return { content: [{ type: 'text', text: store[key] }] }
        } else {
          return { content: [{ type: 'text', text: `Key '${key}' not found in memory.` }] }
        }
      } else {
        if (Object.keys(store).length === 0) {
          return { content: [{ type: 'text', text: 'Memory store is empty.' }] }
        }
        return { content: [{ type: 'text', text: JSON.stringify(store, null, 2) }] }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading memory: ${e}` }] }
    }
  }

  if (name === 'memory_search') {
    const query = String(args?.query ?? '').toLowerCase()
    if (!query) return { content: [{ type: 'text', text: 'Query required.' }] }
    try {
      const results: Array<{ session: string; key: string; value: string }> = []
      // Find all relay-memory-*.json files (covers all sessions sharing /tmp)
      const glob = new Bun.Glob('/tmp/relay-memory-*.json')
      const nowSecs = Date.now() / 1000
      for await (const filePath of glob.scan('/')) {
        const sessionName = filePath.replace('/tmp/relay-memory-', '').replace('.json', '')
        try {
          const f = Bun.file(filePath)
          if (!(await f.exists())) continue
          const raw: Record<string, string | { v: string; exp: number }> = JSON.parse(await f.text())
          for (const [k, entry] of Object.entries(raw)) {
            const v = typeof entry === 'string' ? entry : (entry?.exp && entry.exp <= nowSecs ? null : entry?.v)
            if (v === null) continue  // expired
            if (k.toLowerCase().includes(query) || String(v).toLowerCase().includes(query)) {
              results.push({ session: sessionName, key: k, value: String(v).substring(0, 200) })
            }
          }
        } catch {}
      }
      if (results.length === 0) return { content: [{ type: 'text', text: `No memory entries found matching "${query}".` }] }
      const lines = results.map(r => `[${r.session}] ${r.key}: ${r.value}`)
      return { content: [{ type: 'text', text: lines.join('\n---\n') }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error searching memory: ${e}` }] }
    }
  }

  if (name === 'read_peer_memory') {
    const sessionName = String(args?.session ?? '')
    const key = args?.key ? String(args.key) : undefined
    if (!sessionName) return { content: [{ type: 'text', text: 'Error: session is required.' }] }
    try {
      // Resolve session name → thread_id via sessions.json
      let targetThreadId: string | null = null
      try {
        const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
        const sessions: Array<{ session: string; thread_id: number }> = JSON.parse(readFileSync(sessionsPath, 'utf8'))
        const target = sessions.find(s => s.session === sessionName)
        if (target) targetThreadId = String(target.thread_id)
      } catch {}

      const memFile = targetThreadId
        ? `/tmp/relay-memory-${targetThreadId}.json`
        : `/tmp/relay-memory-${sessionName}.json`  // fallback: try by name

      let store: Record<string, string> = {}
      try {
        const f = Bun.file(memFile)
        if (await f.exists()) store = JSON.parse(await f.text())
      } catch {}

      if (Object.keys(store).length === 0) {
        return { content: [{ type: 'text', text: `Session "${sessionName}" has no memory entries.` }] }
      }

      if (key) {
        if (key in store) return { content: [{ type: 'text', text: store[key] }] }
        return { content: [{ type: 'text', text: `Key '${key}' not found in ${sessionName}'s memory.` }] }
      }
      const lines = Object.entries(store).map(([k, v]) => `${k}: ${String(v).substring(0, 200)}`)
      return { content: [{ type: 'text', text: `[${sessionName}] memory:\n${lines.join('\n')}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading peer memory: ${e}` }] }
    }
  }

  // ── Send Diff ──────────────────────────────────────────────────────────────

  if (name === 'send_diff') {
    const diff    = String(args?.diff ?? '')
    const caption = args?.caption ? String(args.caption) : ''
    try {
      // Parse diff stats from summary line like: "3 files changed, 42 insertions(+), 7 deletions(-)"
      let filesChanged = 0, insertions = 0, deletions = 0
      const statLine = diff.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
      if (statLine) {
        filesChanged = parseInt(statLine[1] ?? '0')
        insertions   = parseInt(statLine[2] ?? '0')
        deletions    = parseInt(statLine[3] ?? '0')
      } else {
        // Count +/- lines as fallback
        for (const line of diff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) insertions++
          else if (line.startsWith('-') && !line.startsWith('---')) deletions++
        }
        filesChanged = new Set(diff.match(/^diff --git .*/gm) ?? []).size
      }

      const summary = `📝 ${caption ? caption + '\n' : ''}+${insertions} insertions, -${deletions} deletions, ${filesChanged} files changed`
      await sendMessage(summary)

      // Send truncated diff content
      const truncated = diff.length > 3000 ? diff.slice(0, 3000) + '\n… (truncated)' : diff
      const escaped = truncated
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      await sendMessage(`<pre>${escaped}</pre>`)

      return { content: [{ type: 'text', text: `Diff sent. ${filesChanged} files, +${insertions}/-${deletions}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error sending diff: ${e}` }] }
    }
  }

  // ── Notify (DM to owner) ──────────────────────────────────────────────────

  if (name === 'notify') {
    const text   = String(args?.text ?? '')
    const urgent = args?.urgent !== false  // default true (with sound)
    const notifyUserId = process.env.NOTIFY_USER_ID
    if (!notifyUserId) {
      return { content: [{ type: 'text', text: 'NOTIFY_USER_ID is not set — cannot send direct notification.' }] }
    }
    try {
      const body: Record<string, unknown> = {
        chat_id:              notifyUserId,
        text:                 autoCode(text),
        parse_mode:           'HTML',
        disable_notification: !urgent,
      }
      const r = await fetch(`${BASE}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const res = await r.json() as { ok: boolean; result?: { message_id: number }; description?: string }
      if (res.ok) {
        return { content: [{ type: 'text', text: `Direct notification sent (message_id: ${res.result?.message_id})` }] }
      } else {
        return { content: [{ type: 'text', text: `Failed to send notification: ${res.description ?? JSON.stringify(res)}` }] }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error sending notification: ${e}` }] }
    }
  }

  // ── Interactive Forms ─────────────────────────────────────────────────────

  const formStatePath = (formId: string) => `/tmp/relay-form-${THREAD_ID}-${formId}.json`

  if (name === 'send_form') {
    const formId   = String(args?.form_id ?? '')
    const step     = Number(args?.step ?? 1)
    const question = String(args?.question ?? '')
    const options  = (args?.options as string[]) ?? []
    const context  = (args?.context as Record<string, unknown>) ?? {}

    if (!formId) return { content: [{ type: 'text', text: 'Error: form_id is required.' }] }
    if (!question) return { content: [{ type: 'text', text: 'Error: question is required.' }] }
    if (options.length === 0) return { content: [{ type: 'text', text: 'Error: options array must not be empty.' }] }

    try {
      // Read existing state to merge context
      let existingContext: Record<string, unknown> = {}
      try {
        const f = Bun.file(formStatePath(formId))
        if (await f.exists()) {
          const existing = JSON.parse(await f.text())
          existingContext = existing.context ?? {}
        }
      } catch {}

      const mergedContext = { ...existingContext, ...context }

      // Persist form state
      const state = {
        form_id:     formId,
        step,
        context:     mergedContext,
        waiting_for: options.join('|'),
        updated_at:  Date.now() / 1000,
      }
      await Bun.write(formStatePath(formId), JSON.stringify(state, null, 2))

      // Send the question with inline buttons (one option per button, up to 3 per row)
      const rows: string[][] = []
      for (let i = 0; i < options.length; i += 3) {
        rows.push(options.slice(i, i + 3))
      }
      const ids = await sendMessage(question, undefined, rows)

      if (ids.length === 0) {
        return { content: [{ type: 'text', text: 'ERROR: failed to send form message.' }], isError: true }
      }
      return { content: [{ type: 'text', text: `Form '${formId}' step ${step} sent. Waiting for: ${options.join(', ')}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error sending form: ${e}` }] }
    }
  }

  if (name === 'get_form_state') {
    const formId = String(args?.form_id ?? '')
    if (!formId) return { content: [{ type: 'text', text: 'Error: form_id is required.' }] }
    try {
      const f = Bun.file(formStatePath(formId))
      if (!(await f.exists())) {
        return { content: [{ type: 'text', text: `No state found for form '${formId}'.` }] }
      }
      const state = await f.text()
      return { content: [{ type: 'text', text: state }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading form state: ${e}` }] }
    }
  }

  if (name === 'update_form_state') {
    const formId  = String(args?.form_id ?? '')
    const step    = args?.step !== undefined ? Number(args.step) : undefined
    const context = (args?.context as Record<string, unknown>) ?? {}

    if (!formId) return { content: [{ type: 'text', text: 'Error: form_id is required.' }] }
    try {
      let state: Record<string, unknown> = { form_id: formId, step: 1, context: {}, updated_at: Date.now() / 1000 }
      try {
        const f = Bun.file(formStatePath(formId))
        if (await f.exists()) state = JSON.parse(await f.text())
      } catch {}

      if (step !== undefined) state.step = step
      state.context = { ...(state.context as Record<string, unknown>), ...context }
      state.updated_at = Date.now() / 1000

      await Bun.write(formStatePath(formId), JSON.stringify(state, null, 2))
      return { content: [{ type: 'text', text: `Form '${formId}' state updated. Step: ${state.step}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error updating form state: ${e}` }] }
    }
  }

  if (name === 'clear_form') {
    const formId = String(args?.form_id ?? '')
    if (!formId) return { content: [{ type: 'text', text: 'Error: form_id is required.' }] }
    try {
      const { unlinkSync, existsSync } = await import('fs')
      const filePath = formStatePath(formId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
        return { content: [{ type: 'text', text: `Form '${formId}' cleared.` }] }
      } else {
        return { content: [{ type: 'text', text: `Form '${formId}' had no state to clear.` }] }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error clearing form: ${e}` }] }
    }
  }

  // ── Feature 3: Voice TTS ──────────────────────────────────────────────────
  if (name === 'send_voice') {
    const text  = String(args?.text ?? '')
    const voice = String(args?.voice ?? 'alloy')
    if (!text) return { content: [{ type: 'text', text: 'Error: text is required.' }] }

    const openaiKey = process.env.OPENAI_API_KEY
    if (!openaiKey) {
      // Fallback to text
      const ids = await sendMessage(`🔊 <i>[TTS unavailable — OPENAI_API_KEY not set]</i>\n${text}`)
      return { content: [{ type: 'text', text: `OPENAI_API_KEY not set — sent as text. message_ids: ${ids.join(', ')}` }] }
    }

    try {
      // Call OpenAI TTS API
      const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({ model: 'tts-1', voice, input: text.slice(0, 4096) }),
        signal: AbortSignal.timeout(30000),
      })
      if (!ttsRes.ok) {
        const errBody = await ttsRes.text()
        return { content: [{ type: 'text', text: `TTS API error ${ttsRes.status}: ${errBody}` }] }
      }

      const audioBuffer = await ttsRes.arrayBuffer()
      const tmpPath = `/tmp/relay-tts-${THREAD_ID}-${Date.now()}.mp3`
      await Bun.write(tmpPath, audioBuffer)

      // Send as voice message via Telegram sendVoice
      const form = new FormData()
      form.append('chat_id', String(CHAT_ID))
      const threadParams = buildMessageThreadParams(THREAD_ID)
      if (threadParams?.message_thread_id != null) {
        form.append('message_thread_id', String(threadParams.message_thread_id))
      }
      form.append('voice', new File([audioBuffer], 'voice.mp3', { type: 'audio/mpeg' }))
      const voiceRes = await fetch(`${BASE}/sendVoice`, { method: 'POST', body: form })
      const voiceJson = await voiceRes.json() as { ok: boolean; result?: { message_id: number } }

      // Clean up tmp file
      try { const { unlinkSync } = await import('fs'); unlinkSync(tmpPath) } catch (_) {}

      if (voiceJson.ok) {
        return { content: [{ type: 'text', text: `Voice message sent (message_id: ${voiceJson.result?.message_id})` }] }
      } else {
        return { content: [{ type: 'text', text: `Failed to send voice: ${JSON.stringify(voiceJson)}` }] }
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error in send_voice: ${e}` }] }
    }
  }

  // ── Feature 5: Task marketplace ───────────────────────────────────────────
  const TASK_MARKET_FILE = '/tmp/relay-task-market.jsonl'

  if (name === 'publish_task') {
    const task            = String(args?.task ?? '')
    const requiredSkills  = (args?.required_skills as string[] | undefined) ?? []
    const deadlineMinutes = Number(args?.deadline_minutes ?? 60)
    if (!task) return { content: [{ type: 'text', text: 'Error: task is required.' }] }

    const crypto = await import('crypto')
    const id = 'mkt-' + crypto.randomUUID().slice(0, 8)
    const now = Date.now() / 1000
    const entry = {
      id,
      task,
      required_skills: requiredSkills,
      from_thread: THREAD_ID,
      from_session: process.env.SESSION_NAME ?? `session-${THREAD_ID}`,
      published_at: now,
      deadline: now + deadlineMinutes * 60,
      status: 'open',
    }
    try {
      const { appendFileSync } = await import('fs')
      appendFileSync(TASK_MARKET_FILE, JSON.stringify(entry) + '\n')
      return { content: [{ type: 'text', text: `Task published. id: ${id}\nDeadline: ${deadlineMinutes}m` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error publishing task: ${e}` }] }
    }
  }

  if (name === 'claim_task') {
    const taskId = String(args?.task_id ?? '')
    if (!taskId) return { content: [{ type: 'text', text: 'Error: task_id is required.' }] }

    try {
      const { readFileSync, writeFileSync, existsSync } = await import('fs')
      if (!existsSync(TASK_MARKET_FILE)) return { content: [{ type: 'text', text: 'No tasks in marketplace.' }] }

      const lines = readFileSync(TASK_MARKET_FILE, 'utf8').split('\n').filter(l => l.trim())
      let found: Record<string, unknown> | null = null
      const updated = lines.map(line => {
        try {
          const t = JSON.parse(line) as Record<string, unknown>
          if (t.id === taskId) {
            if (t.status !== 'open') return line // already claimed
            found = { ...t }
            return JSON.stringify({ ...t, status: 'claimed', claimed_by: process.env.SESSION_NAME ?? `session-${THREAD_ID}`, claimed_at: Date.now() / 1000 })
          }
        } catch {}
        return line
      })

      if (!found) return { content: [{ type: 'text', text: `Task '${taskId}' not found.` }] }

      writeFileSync(TASK_MARKET_FILE, updated.join('\n') + '\n')

      // Notify publishing session
      const fromThread = (found as Record<string, unknown>).from_thread as number
      if (fromThread && fromThread !== THREAD_ID) {
        const selfName = process.env.SESSION_NAME ?? `session-${THREAD_ID}`
        const notifyEntry = JSON.stringify({
          text: `[Marketplace] Task <b>${taskId}</b> claimed by ${selfName}\nTask: ${(found as Record<string, unknown>).task}`,
          user: `market:${selfName}`,
          message_id: -Date.now(),
          ts: Date.now() / 1000,
          force: true,
        })
        await Bun.write(`/tmp/tg-queue-${fromThread}.jsonl`, notifyEntry + '\n', { append: true })
      }

      return { content: [{ type: 'text', text: `Task '${taskId}' claimed.\n${JSON.stringify(found, null, 2)}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error claiming task: ${e}` }] }
    }
  }

  if (name === 'list_available_tasks') {
    try {
      const { readFileSync, existsSync } = await import('fs')
      if (!existsSync(TASK_MARKET_FILE)) return { content: [{ type: 'text', text: 'No tasks in marketplace.' }] }

      // Get this session's skills from sessions.json
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      let mySkills: string[] = []
      try {
        const sessions: Array<{ thread_id: number; skills?: string[] }> = JSON.parse(readFileSync(sessionsPath, 'utf8'))
        const me = sessions.find(s => s.thread_id === THREAD_ID)
        mySkills = me?.skills ?? []
      } catch {}

      const now = Date.now() / 1000
      const lines = readFileSync(TASK_MARKET_FILE, 'utf8').split('\n').filter(l => l.trim())
      const available: Record<string, unknown>[] = []

      for (const line of lines) {
        try {
          const t = JSON.parse(line) as Record<string, unknown>
          if (t.status !== 'open') continue
          if (typeof t.deadline === 'number' && t.deadline < now) continue // expired
          if (t.from_thread === THREAD_ID) continue // own tasks

          // Skill matching: if task requires skills and we have some, check overlap
          const req = (t.required_skills as string[] | undefined) ?? []
          if (req.length > 0 && mySkills.length > 0) {
            const hasSkill = req.some(s => mySkills.includes(s))
            if (!hasSkill) continue
          }
          available.push(t)
        } catch {}
      }

      if (available.length === 0) return { content: [{ type: 'text', text: 'No available tasks matching your skills.' }] }

      const lines2 = available.map(t =>
        `• [${t.id}] ${t.task}\n  Skills: ${(t.required_skills as string[]).join(', ') || 'any'} — expires in ${Math.round((Number(t.deadline) - now) / 60)}m`
      )
      return { content: [{ type: 'text', text: lines2.join('\n\n') }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error listing tasks: ${e}` }] }
    }
  }

  // ── Agent state machine ───────────────────────────────────────────────────

  if (name === 'set_agent_state') {
    const state      = String(args?.state ?? 'idle')
    const task       = args?.task       ? String(args.task) : null
    const blockedBy  = args?.blocked_by ? String(args.blocked_by) : null
    const stateFile  = `/tmp/relay-agent-state-${THREAD_ID}.json`
    const entry = {
      thread_id:  THREAD_ID,
      state,
      task,
      blocked_by: blockedBy,
      ts: Math.floor(Date.now() / 1000),
    }
    try {
      await Bun.write(stateFile, JSON.stringify(entry, null, 2))
      return { content: [{ type: 'text', text: `State set to '${state}'${task ? ` (${task})` : ''}.` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error writing state: ${e}` }] }
    }
  }

  // ── Orchestrator: split_task ───────────────────────────────────────────────

  if (name === 'split_task') {
    const subtasks    = (args?.subtasks as Array<{ session: string; prompt: string }>) ?? []
    const timeoutSecs = Number(args?.timeout_secs ?? 180)
    const context     = args?.context ? String(args.context) : null
    if (subtasks.length === 0) return { content: [{ type: 'text', text: 'Error: subtasks array is required and must not be empty.' }] }

    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string }> =
        JSON.parse(readFileSync(sessionsPath, 'utf8'))

      const queueDir   = '/tmp'
      const dispatched: Array<{ session: string; task_id: string }> = []
      const now        = Math.floor(Date.now() / 1000)

      for (const sub of subtasks) {
        const target = sessions.find(s => s.session === sub.session)
        if (!target) continue
        const taskId   = `split-${now}-${sub.session}-${Math.random().toString(36).slice(2, 6)}`
        const fullPrompt = context
          ? `[Context] ${context}\n\n[Task] ${sub.prompt}\n\nWhen done, call complete_task with task_id="${taskId}" and your result.`
          : `${sub.prompt}\n\nWhen done, call complete_task with task_id="${taskId}" and your result.`
        const entry = {
          message_id: -(Date.now() % 2147483647),
          user:       `orchestrator:${THREAD_ID}`,
          text:       fullPrompt,
          ts:         now,
          via:        'split_task',
          force:      true,
          task_id:    taskId,
        }
        const queueFile = `${queueDir}/tg-queue-${target.thread_id}.jsonl`
        const { appendFileSync } = await import('fs')
        appendFileSync(queueFile, JSON.stringify(entry) + '\n')
        dispatched.push({ session: sub.session, task_id: taskId })
      }

      if (dispatched.length === 0) return { content: [{ type: 'text', text: 'No valid target sessions found.' }] }

      // Wait for all results
      const deadline  = Date.now() + timeoutSecs * 1000
      const results: Record<string, string> = {}
      while (Date.now() < deadline) {
        for (const d of dispatched) {
          if (results[d.session]) continue
          const resultFile = `/tmp/relay-task-result-${d.task_id}.json`
          const f = Bun.file(resultFile)
          if (await f.exists()) {
            try {
              const data = JSON.parse(await f.text())
              results[d.session] = data.result ?? String(data)
              const { unlinkSync } = await import('fs')
              try { unlinkSync(resultFile) } catch (_) {}
            } catch (_) {}
          }
        }
        if (Object.keys(results).length === dispatched.length) break
        await Bun.sleep(2000)
      }

      const lines: string[] = [`Dispatched ${dispatched.length} subtasks, received ${Object.keys(results).length}/${dispatched.length} results:\n`]
      for (const d of dispatched) {
        lines.push(`── ${d.session} ──`)
        lines.push(results[d.session] ?? '(no result — timed out)')
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error in split_task: ${e}` }] }
    }
  }

  // ── Ephemeral agents: spawn_agent ──────────────────────────────────────────

  if (name === 'spawn_agent') {
    const task        = String(args?.task ?? '')
    const workdir     = args?.workdir ? String(args.workdir) : '/relay'
    const wait        = Boolean(args?.wait ?? false)
    const timeoutSecs = Number(args?.timeout_secs ?? 300)
    if (!task) return { content: [{ type: 'text', text: 'Error: task is required.' }] }

    const agentId   = `ephemeral-${Date.now()}`
    const resultFile = `/tmp/relay-task-result-${agentId}.json`
    const taskFull  = wait
      ? `${task}\n\nWhen done, write your result to: ${resultFile} as JSON with key "result". Example: {"result": "your answer here"}`
      : task

    try {
      // Spawn via relay-api /api/spawn-agent endpoint
      const { execSync } = await import('child_process')
      const apiIp = (() => {
        try { return execSync('getent hosts relay-api | awk \'{print $1}\' | head -1', { timeout: 3000 }).toString().trim() } catch { return '' }
      })()
      if (!apiIp) return { content: [{ type: 'text', text: 'Error: relay-api not reachable — cannot spawn agent.' }] }

      const payload = JSON.stringify({ agent_id: agentId, task: taskFull, workdir })
      const curlCmd = `curl -sf --connect-timeout 5 -X POST -H "Content-Type: application/json" -u "${process.env.AUTH_USER ?? 'relay'}:${process.env.AUTH_PASS ?? ''}" -d '${payload.replace(/'/g, "'\\''")}' http://${apiIp}:7070/api/spawn-agent`
      const resp = execSync(curlCmd, { timeout: 10000 }).toString().trim()
      const parsed = JSON.parse(resp)
      if (!parsed.ok) return { content: [{ type: 'text', text: `Error spawning agent: ${parsed.error ?? resp}` }] }

      if (!wait) {
        return { content: [{ type: 'text', text: `Ephemeral agent spawned (id: ${agentId}). Running in background — no result expected.` }] }
      }

      // Wait for result file
      const deadline = Date.now() + timeoutSecs * 1000
      while (Date.now() < deadline) {
        const f = Bun.file(resultFile)
        if (await f.exists()) {
          try {
            const data = JSON.parse(await f.text())
            const { unlinkSync } = await import('fs')
            try { unlinkSync(resultFile) } catch (_) {}
            return { content: [{ type: 'text', text: `Agent result:\n${data.result ?? JSON.stringify(data)}` }] }
          } catch (_) {}
        }
        await Bun.sleep(3000)
      }
      return { content: [{ type: 'text', text: `Ephemeral agent (${agentId}) did not complete within ${timeoutSecs}s.` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error spawning agent: ${e}` }] }
    }
  }

  // ── schedule_message ──────────────────────────────────────────────────────

  if (name === 'schedule_message') {
    const text      = String(args?.text ?? '')
    const delaySecs = Number(args?.delay_secs ?? 0)
    const label     = args?.label ? String(args.label) : 'scheduled'
    if (!text) return { content: [{ type: 'text', text: 'Error: text is required.' }] }
    if (delaySecs <= 0) return { content: [{ type: 'text', text: 'Error: delay_secs must be > 0.' }] }

    const deliverAt = Math.floor(Date.now() / 1000) + delaySecs
    const entry = JSON.stringify({
      message_id: -(Date.now()),
      user: `system:${label}`,
      text: `⏰ [${label}] ${text}`,
      ts: deliverAt,
      via: 'scheduled',
      force: true,
    })

    // Use a background sleep + append to inject the message at the right time
    const queueFile = QUEUE_FILE
    const { execSync } = await import('child_process')
    const cmd = `(sleep ${delaySecs} && echo '${entry.replace(/'/g, "'\\''")}' >> ${queueFile}) &`
    try {
      execSync(cmd, { shell: '/bin/bash', timeout: 1000 })
      const deliverTime = new Date(deliverAt * 1000).toISOString()
      return { content: [{ type: 'text', text: `Scheduled. Will deliver at ${deliverTime} (in ${delaySecs}s).` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error scheduling message: ${e}` }] }
    }
  }

  // ── get_metrics ────────────────────────────────────────────────────────────

  if (name === 'get_metrics') {
    const targetSession = args?.session ? String(args.session) : (process.env.SESSION_NAME ?? `session-${THREAD_ID}`)
    const period = String(args?.period ?? 'today')

    // Resolve session → thread_id
    let targetTid = THREAD_ID
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number }> = JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const found = sessions.find(s => s.session === targetSession)
      if (found) targetTid = found.thread_id
    } catch {}

    const statsFile = `/tmp/token-stats-${targetTid}.jsonl`
    const lines: string[] = [`=== Metrics: ${targetSession} (${period}) ===`]

    try {
      const { existsSync, readFileSync: rfs } = await import('fs')
      if (existsSync(statsFile)) {
        const rawLines = rfs(statsFile, 'utf8').split('\n').filter(Boolean)
        const now = Date.now() / 1000
        const todayStr = new Date().toISOString().split('T')[0]
        const periodSecs = period === '5m' ? 300 : period === '1h' ? 3600 : 86400

        let totalIn = 0, totalOut = 0, totalCost = 0, count = 0
        for (const l of rawLines) {
          try {
            const e = JSON.parse(l)
            const ts = e.ts ? Math.floor(new Date(e.ts).getTime() / 1000) : 0
            const inPeriod = period === 'today' ? e.ts?.startsWith(todayStr) : (now - ts) < periodSecs
            if (inPeriod) {
              totalIn  += e.input  || 0
              totalOut += e.output || 0
              totalCost += e.cost_usd || 0
              count++
            }
          } catch {}
        }
        lines.push(`Turns: ${count}`)
        lines.push(`Input tokens: ${totalIn.toLocaleString()}`)
        lines.push(`Output tokens: ${totalOut.toLocaleString()}`)
        lines.push(`Cost: $${totalCost.toFixed(4)}`)
      } else {
        lines.push('No token stats available.')
      }

      // Recent errors
      const errFile = '/tmp/relay-errors.jsonl'
      if (existsSync(errFile)) {
        const errLines = rfs(errFile, 'utf8').split('\n').filter(Boolean).slice(-5)
        if (errLines.length > 0) {
          lines.push(`\nRecent errors (last 5):`)
          for (const l of errLines) {
            try {
              const e = JSON.parse(l)
              lines.push(`• [${e.t}] ${e.type}: ${e.message?.substring(0, 100)}`)
            } catch {}
          }
        }
      }

      // Uptime from last-sent file
      const lastSentFile = `/tmp/tg-last-sent-${targetTid}`
      if (existsSync(lastSentFile)) {
        const lastSent = parseFloat(rfs(lastSentFile, 'utf8').trim())
        if (!isNaN(lastSent)) {
          const agoMin = Math.round((Date.now() / 1000 - lastSent) / 60)
          lines.push(`\nLast response: ${agoMin}m ago`)
        }
      }
    } catch (e) {
      lines.push(`Error reading metrics: ${e}`)
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  if (name === 'ping_session') {
    const targetSession = String(args?.session ?? '')
    const timeoutSecs = Number(args?.timeout_secs ?? 20)
    if (!targetSession) return { content: [{ type: 'text', text: 'Error: session is required.' }] }
    try {
      const sessionsPath = new URL('../sessions.json', import.meta.url).pathname
      const sessions: Array<{ session: string; thread_id: number; host?: string }> = JSON.parse(readFileSync(sessionsPath, 'utf8'))
      const target = sessions.find(s => s.session === targetSession)
      if (!target) return { content: [{ type: 'text', text: `Session "${targetSession}" not found.` }] }

      const lastSentFile = `/tmp/tg-last-sent-${target.thread_id}`
      const { existsSync, readFileSync: rfs } = await import('fs')

      // Check last activity before ping
      const beforeTs = existsSync(lastSentFile) ? parseFloat(rfs(lastSentFile, 'utf8').trim()) : 0
      const pingTs = Date.now() / 1000

      // Inject ping message into target queue
      const pingEntry = JSON.stringify({
        message_id: -(Date.now()),
        user: `system:ping`,
        text: `[ping from ${process.env.SESSION_NAME ?? 'relay'}] Are you alive? Reply with pong.`,
        ts: Math.floor(pingTs),
        via: 'ping',
        force: true,
      })
      const queueFile = `/tmp/tg-queue-${target.thread_id}.jsonl`
      const { appendFileSync } = await import('fs')
      appendFileSync(queueFile, pingEntry + '\n')

      // Wait for new activity (last-sent file newer than before ping)
      const deadline = Date.now() + timeoutSecs * 1000
      while (Date.now() < deadline) {
        await Bun.sleep(1000)
        try {
          const afterTs = existsSync(lastSentFile) ? parseFloat(rfs(lastSentFile, 'utf8').trim()) : 0
          if (afterTs > pingTs) {
            const rtt = Math.round(afterTs - pingTs)
            return { content: [{ type: 'text', text: `✅ ${targetSession} responded in ~${rtt}s` }] }
          }
        } catch {}
      }
      return { content: [{ type: 'text', text: `⚠️ ${targetSession} did not respond within ${timeoutSecs}s` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error pinging session: ${e}` }] }
    }
  }

  if (name === 'get_logs') {
    const service = String(args?.service ?? '')
    const lines = Number(args?.lines ?? 30)
    if (!service) return { content: [{ type: 'text', text: 'Error: service is required.' }] }
    try {
      const { execSync } = await import('child_process')
      let output: string
      if (service.startsWith('/')) {
        // Log file path
        const { readFileSync: rfs } = await import('fs')
        const all = rfs(service, 'utf8').split('\n')
        output = all.slice(-lines).join('\n')
      } else {
        // Docker container
        const containerName = service.includes('relay-session-') ? service : `relay-session-${service}`
        try {
          output = execSync(`docker logs --tail=${lines} ${containerName} 2>&1`, { timeout: 10000 }).toString()
        } catch {
          // Try exact name
          output = execSync(`docker logs --tail=${lines} ${service} 2>&1`, { timeout: 10000 }).toString()
        }
      }
      const trimmed = output.substring(0, 3000)
      return { content: [{ type: 'text', text: trimmed || '(no output)' }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error getting logs: ${e}` }] }
    }
  }

  if (name === 'http_get') {
    const url = String(args?.url ?? '')
    const headers = (args?.headers ?? {}) as Record<string, string>
    const timeoutSecs = Number(args?.timeout_secs ?? 10)
    if (!url) return { content: [{ type: 'text', text: 'Error: url is required.' }] }
    try {
      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutSecs * 1000),
      })
      const body = await resp.text()
      const trimmed = body.substring(0, 3000)
      return { content: [{ type: 'text', text: `HTTP ${resp.status} ${resp.statusText}\n${trimmed}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e}` }] }
    }
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
// Allow up to 10s for any existing lock to clear (e.g. after container restart)
db.run('PRAGMA busy_timeout = 10000')
db.run('PRAGMA journal_mode = WAL')
db.run(`CREATE TABLE IF NOT EXISTS messages (
  rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER UNIQUE,
  user     TEXT,
  text     TEXT,
  ts       TEXT
)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_ts ON messages(ts)`)

function dbInsert(msg: TgMessage): void {
  db.run('INSERT OR IGNORE INTO messages (message_id, user, text, ts) VALUES (?, ?, ?, ?)',
    [msg.message_id, msg.user, msg.text, msg.ts])
  db.run('DELETE FROM messages WHERE rowid NOT IN (SELECT rowid FROM messages ORDER BY rowid DESC LIMIT 500)')
}

function dbRecent(limit: number): TgMessage[] {
  return (db.query('SELECT message_id, user, text, ts FROM messages ORDER BY rowid DESC LIMIT ?').all(limit) as TgMessage[]).reverse()
}

/** On startup: backfill DB from queue file so fetch_messages returns valid history immediately */
async function dbWarmFromQueue(): Promise<void> {
  try {
    const file = Bun.file(QUEUE_FILE)
    if (!(await file.exists())) return
    const count = (db.query('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n
    // Only warm if DB is sparse (fresh start or DB was recreated)
    if (count > 20) return
    for (const line of (await file.text()).split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as QueueEntry & { force?: boolean }
        // Skip system/force messages — only real user messages are useful for history
        if (e.force || !e.user || e.user.startsWith('system')) continue
        if (e.message_id > 0) {
          const isoTs = new Date(e.ts * 1000).toISOString()
          dbInsert({ message_id: e.message_id, user: e.user, text: e.text, ts: isoTs })
        }
      } catch {}
    }
    process.stderr.write(`[telegram] DB warmed from queue (${count} existing rows)\n`)
  } catch {}
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
// Exit when Claude Code closes the MCP stdio pipe (e.g. on Claude restart/exit)
process.stdin.on('end',   () => { cleanup(); process.exit(0) })
process.stdin.on('close', () => { cleanup(); process.exit(0) })

type QueueEntry = {
  text: string
  user: string
  message_id: number
  thread_id: number
  chat_id: number
  ts: number
  photo_path?: string
}

// Persistent state: last delivered message_id + acked force IDs survive MCP restarts
const STATE_FILE = `/tmp/tg-queue-${THREAD_ID}.state`

interface State { lastId: number; ackedForce: number[] }

async function loadState(): Promise<State> {
  try {
    const f = Bun.file(STATE_FILE)
    if (await f.exists()) {
      const raw = await f.text()
      // New format: JSON {"lastId":N,"ackedForce":[...]}
      if (raw.trim().startsWith('{')) {
        const parsed = JSON.parse(raw) as Partial<State>
        let lastId = parsed.lastId ?? 0
        if (lastId > 1e8) { lastId = 0 }  // corrupted
        return { lastId, ackedForce: parsed.ackedForce ?? [] }
      }
      // Legacy format: plain number string
      const id = parseInt(raw, 10) || 0
      if (id > 1e8) {
        process.stderr.write(`[telegram] state ${id} looks like a Unix timestamp, resetting to 0\n`)
        await saveState(0, [])
        return { lastId: 0, ackedForce: [] }
      }
      return { lastId: id, ackedForce: [] }
    }
  } catch {}
  return { lastId: 0, ackedForce: [] }
}

async function saveState(lastId: number, ackedForce: number[]): Promise<void> {
  // Atomic write: write to temp file then rename to avoid partial-write corruption
  const tmp = STATE_FILE + '.tmp'
  try {
    await Bun.write(tmp, JSON.stringify({ lastId, ackedForce }))
    const { renameSync } = await import('fs')
    renameSync(tmp, STATE_FILE)
  } catch {
    // fallback to direct write if rename fails (e.g. cross-device)
    try { await Bun.write(STATE_FILE, JSON.stringify({ lastId, ackedForce })) } catch {}
  }
}

// Keep backward-compat callers that only update lastId
async function saveLastId(id: number, ackedForce?: number[]): Promise<void> {
  const cur = ackedForce ?? (await loadState()).ackedForce
  await saveState(id, cur)
}

/** Remove queue entries older than 6h (force) or 2h (regular) that have already been delivered. */
async function trimQueue(lastId: number): Promise<void> {
  try {
    const file = Bun.file(QUEUE_FILE)
    if (!(await file.exists())) return
    const now = Date.now() / 1000
    const cutoff6h  = now - 6 * 60 * 60
    const cutoff2h  = now - 2 * 60 * 60
    const lines = (await file.text()).split('\n').filter(line => {
      if (!line.trim()) return false
      try {
        const e = JSON.parse(line) as QueueEntry & { force?: boolean }
        // Always drop force/system messages older than 6h
        if (e.force && e.ts < cutoff6h) return false
        // Drop regular messages older than 2h (regardless of delivery status)
        if (!e.force && e.ts < cutoff2h) return false
        // Keep undelivered regular messages (within 2h window)
        if (!e.force && e.message_id > lastId) return true
        // Keep recent force/system entries (within 6h)
        if (e.force && e.ts > cutoff6h) return true
        // Keep recent regular entries (within 2h)
        if (!e.force && e.ts > cutoff2h) return true
        return false
      } catch { return false }
    })
    await Bun.write(QUEUE_FILE, lines.join('\n') + (lines.length ? '\n' : ''))
  } catch {}
}

async function poll(): Promise<void> {
  // Deliver any message with message_id > lastDeliveredId, one per poll cycle
  const state = await loadState()
  let lastId = state.lastId
  // ackedForceIds: force message IDs that were already delivered — persisted across restarts
  const ackedForceIds = new Set<number>(state.ackedForce)
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
          await saveState(lastId, [...ackedForceIds])
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[telegram] state sanity check error: ${e}\n`)
  }

  // Pre-populate deliveredForce from persisted ackedForce (survives restarts)
  // and also from force entries older than 10 min (fallback for first startup).
  for (const id of ackedForceIds) deliveredForce.set(id, Infinity)
  try {
    const qFile = Bun.file(QUEUE_FILE)
    if (await qFile.exists()) {
      for (const line of (await qFile.text()).split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as QueueEntry & { force?: boolean }
          if (e.force && !deliveredForce.has(e.message_id)) {
            const ageMs = Date.now() - e.ts * 1000
            if (ageMs > 10 * 60 * 1000) {
              deliveredForce.set(e.message_id, Infinity)
              ackedForceIds.add(e.message_id)
            }
          }
        } catch {}
      }
    }
  } catch {}

  // Backfill history DB from queue file so fetch_messages works immediately
  await dbWarmFromQueue()

  // Wait for Claude to complete MCP handshake before sending first notification.
  // 1s was too short — Claude needs ~3-5s to process list_tools, initialize session context,
  // and become ready to handle notifications/claude/channel.
  await Bun.sleep(4000)

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

  // Track Claude activity: updated whenever Claude calls any MCP tool.
  // Used to confirm notification delivery — we only advance lastId after Claude shows activity.
  let lastActivityTs = 0
  let pendingDelivery: { message_id: number; sentAt: number; firstSentAt: number; retryCount: number } | null = null
  _updateActivity = () => { lastActivityTs = Date.now() }

  // Jitter: stagger first notification delivery after restart to avoid cascade re-delivery storms
  // when multiple sessions all restart simultaneously (e.g. after docker restart).
  const startupJitterMs = Math.floor(Math.random() * 500)  // 0–500ms per-instance jitter
  if (startupJitterMs > 0) await Bun.sleep(startupJitterMs)

  let pollCount = 0
  let lastQueueSize = 0     // bytes consumed so far — only read new bytes each cycle
  let startupRead = true    // first poll reads full file to catch up on pending messages
  while (true) {
    pollCount++
    // Trim queue every ~5 minutes (600 cycles × 500ms); also trigger full rescan to catch any missed lines
    if (pollCount % 600 === 0) { void trimQueue(lastId); lastQueueSize = 0 }
    // Re-read state file every 10s (20 cycles × 500ms) to pick up manual lastId advances
    if (pollCount % 20 === 0) {
      try {
        const sf = Bun.file(STATE_FILE)
        if (await sf.exists()) {
          const s = JSON.parse(await sf.text()) as { lastId?: number }
          if (s.lastId && s.lastId > lastId) {
            process.stderr.write(`[telegram] state file advanced lastId ${lastId} → ${s.lastId}\n`)
            lastId = s.lastId
            pendingDelivery = null
          }
        }
      } catch {}
    }

    try {
      // If Claude showed activity after we sent a pending notification, confirm delivery
      if (pendingDelivery && lastActivityTs > pendingDelivery.sentAt) {
        lastId = pendingDelivery.message_id
        await saveState(lastId, [...ackedForceIds])
        process.stderr.write(`[telegram] delivery confirmed for msg ${pendingDelivery.message_id}\n`)
        pendingDelivery = null
      }

      // Re-send pending notification if Claude hasn't responded within retry window.
      // Uses exponential backoff: 30s → 60s → 90s → 120s (capped) to avoid hammering.
      // (Claude may be in the middle of a long tool chain — Bash, Edit, etc. — and genuinely
      //  busy without calling any MCP tool. 3s was too aggressive and caused duplicate delivery.)
      const retryWindowMs = pendingDelivery
        ? Math.min(30_000 + (pendingDelivery.retryCount ?? 0) * 30_000, 120_000)
        : 30_000
      if (pendingDelivery && Date.now() - pendingDelivery.sentAt > retryWindowMs) {
        // Give up after 5 minutes — Claude may be busy with long-running tools (Bash, file ops)
        // which don't trigger lastActivityTs. Only skip if truly unresponsive for a long time.
        const totalAge = Date.now() - pendingDelivery.firstSentAt
        if (totalAge > 300_000) {
          process.stderr.write(`[telegram] giving up on msg ${pendingDelivery.message_id} after 5min — advancing lastId\n`)
          lastId = pendingDelivery.message_id
          await saveState(lastId, [...ackedForceIds])
          pendingDelivery = null
          await Bun.sleep(500)
          continue
        }
        process.stderr.write(`[telegram] no activity after ${retryWindowMs/1000}s (retry #${(pendingDelivery.retryCount??0)+1}) — retrying notification for msg ${pendingDelivery.message_id}\n`)
        // Don't clear pendingDelivery — keep retrying until Claude responds or message expires
        pendingDelivery.retryCount = (pendingDelivery.retryCount ?? 0) + 1
        pendingDelivery.sentAt = Date.now()  // reset timer for next retry
        // Re-read queue to find and re-send the message
        try {
          const retryFile = Bun.file(QUEUE_FILE)
          if (await retryFile.exists()) {
            for (const line of (await retryFile.text()).split('\n')) {
              if (!line.trim()) continue
              try {
                const e = JSON.parse(line) as QueueEntry & { force?: boolean }
                if (e.message_id === pendingDelivery.message_id) {
                  const isoTs = new Date(e.ts * 1000).toISOString()
                  void mcp.notification({
                    method: 'notifications/claude/channel',
                    params: {
                      content: e.text,
                      meta: { chat_id: String(CHAT_ID), thread_id: String(THREAD_ID), message_id: e.message_id, user: e.user, ts: isoTs },
                    },
                  })
                  break
                }
              } catch {}
            }
          }
        } catch {}
      }

      const file = Bun.file(QUEUE_FILE)
      if (!(await file.exists())) { await Bun.sleep(500); continue }

      // On first poll, force a full read to catch any pending messages from before startup
      if (startupRead) {
        lastQueueSize = 0
        startupRead = false
      }

      // Only read new bytes since last poll — avoids re-scanning whole file each cycle
      let rawText: string
      try {
        const { statSync, openSync, readSync, closeSync } = await import('fs')
        const currentSize = statSync(QUEUE_FILE).size
        if (currentSize === lastQueueSize) { await Bun.sleep(500); continue }
        // If file shrank (rotation/trim), reset position for a full re-read
        if (currentSize < lastQueueSize) lastQueueSize = 0
        const newBytes = currentSize - lastQueueSize
        const buf = Buffer.allocUnsafe(newBytes)
        const fd = openSync(QUEUE_FILE, 'r')
        readSync(fd, buf, 0, newBytes, lastQueueSize)
        closeSync(fd)
        rawText = buf.toString('utf8')
        lastQueueSize = currentSize
      } catch { await Bun.sleep(500); continue }

      // Validate and repair queue: skip malformed/truncated lines to prevent partial-line corruption
      // from crashing the poll loop. Track corrupt line count for debugging.
      let sentOne = false
      let corruptLines = 0

      for (const line of rawText.split('\n')) {
        if (!line.trim() || sentOne) continue
        // Quick pre-validation: must start with '{' and end with '}'
        const trimmed = line.trim()
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) { corruptLines++; continue }
        try {
          const entry = JSON.parse(trimmed) as QueueEntry & { force?: boolean }
          // Sanity check required fields
          if (typeof entry.message_id !== 'number' || typeof entry.text !== 'string') { corruptLines++; continue }
          const { text: msgText, user, message_id, ts, photo_path, force } = entry

          const ageMs = Date.now() - ts * 1000
          const isRecent = ageMs < 10 * 60 * 1000

          // Skip already-confirmed regular messages
          if (message_id <= lastId && !force && !pendingDelivery) continue
          // Skip if this message is already pending confirmation
          if (pendingDelivery && message_id === pendingDelivery.message_id) continue
          // Skip force messages already delivered (in ackedForceIds = Infinity, or recent delivery < 15s)
          if (force && deliveredForce.has(message_id)) {
            const deliveredAt = deliveredForce.get(message_id)!
            if (deliveredAt === Infinity || Date.now() - deliveredAt < 15_000) continue
          }
          // Skip old messages that are already behind lastId (not pending, not recent)
          if (message_id <= lastId && !force && !isRecent) continue

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

          if (force) {
            deliveredForce.set(message_id, Date.now())
            ackedForceIds.add(message_id)
            // Keep only recent ackedForce IDs to prevent state bloat.
            // IDs are negative unix-ms timestamps — strip those older than 2 hours.
            const twoHoursAgoMs = Date.now() - 2 * 60 * 60 * 1000
            const trimmed = [...ackedForceIds].filter(id => {
              // Negative IDs encode -(timestamp_ms) — keep if "recent" enough
              // Positive force IDs (shouldn't exist) keep always
              if (id >= 0) return true
              return -id > twoHoursAgoMs
            }).slice(-200)
            ackedForceIds.clear()
            for (const id of trimmed) ackedForceIds.add(id)
            await saveState(lastId, trimmed)
          } else if (message_id > lastId) {
            // Don't advance lastId until we confirm Claude received and acted on the notification.
            // This ensures that if Claude is busy (long tool chain) and misses the notification,
            // the message stays pending and will be re-delivered — not silently skipped.
            pendingDelivery = { message_id, sentAt: Date.now(), firstSentAt: Date.now(), retryCount: 0 }
          }
          sentOne = true

          process.stderr.write(`[telegram] notification sent: ${user}: ${msgText}\n`)
        } catch (e) {
          process.stderr.write(`[telegram] parse error: ${e}\n`)
          corruptLines++
        }
      }
      if (corruptLines > 0) {
        process.stderr.write(`[telegram] queue: skipped ${corruptLines} corrupt/truncated line(s)\n`)
      }
    } catch (err) {
      process.stderr.write(`[telegram] poll error: ${err}\n`)
    }

    await Bun.sleep(500)
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

// HTTP push endpoint — must start BEFORE mcp.connect (which blocks until disconnection)
// Allows relay-api to deliver messages to remote sessions via HTTP POST /push
const PUSH_PORT = process.env.PUSH_PORT ? parseInt(process.env.PUSH_PORT) : (process.env.REMOTE_SESSION === '1' ? 7099 : 0)
if (PUSH_PORT > 0) {
  const pushSecret = process.env.PUSH_SECRET || ''
  Bun.serve({
    port: PUSH_PORT,
    hostname: '0.0.0.0',
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/push') {
        return new Response('not found', { status: 404 })
      }
      if (pushSecret && req.headers.get('x-push-secret') !== pushSecret) {
        return new Response('unauthorized', { status: 401 })
      }
      try {
        const entry = await req.json()
        const line = JSON.stringify(entry) + '\n'
        await Bun.write(Bun.file(QUEUE_FILE), await Bun.file(QUEUE_FILE).text().catch(() => '') + line)
        process.stderr.write(`[telegram] push received: msg ${entry.message_id} from ${entry.user}\n`)
        return new Response('ok')
      } catch (e) {
        return new Response('bad request', { status: 400 })
      }
    }
  })
  process.stderr.write(`[telegram] HTTP push endpoint listening on :${PUSH_PORT}\n`)
}

const transport = new StdioServerTransport()
await mcp.connect(transport)

// Start polling after connecting
void poll()

process.stderr.write(`[telegram] MCP server ready — listening on topic ${THREAD_ID} in chat ${CHAT_ID}\n`)
