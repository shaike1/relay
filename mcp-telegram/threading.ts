export const TELEGRAM_GENERAL_TOPIC_ID = 1

/**
 * General forum topic (id=1) must be treated like a regular supergroup send.
 * Telegram rejects sendMessage/sendMedia with message_thread_id=1.
 */
export function buildMessageThreadParams(messageThreadId: number | undefined): { message_thread_id: number } | undefined {
  if (messageThreadId == null) return undefined
  const normalized = Math.trunc(messageThreadId)
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) return undefined
  return { message_thread_id: normalized }
}

/**
 * Typing indicators are different: Telegram General topic still needs the
 * thread id for sendChatAction to render in the topic UI.
 */
export function buildTypingThreadParams(messageThreadId: number | undefined): { message_thread_id: number } | undefined {
  if (messageThreadId == null) return undefined
  return { message_thread_id: Math.trunc(messageThreadId) }
}
