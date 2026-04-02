import { describe, expect, test } from 'bun:test'

import { TELEGRAM_GENERAL_TOPIC_ID, buildMessageThreadParams, buildTypingThreadParams } from './threading.ts'

describe('Telegram topic threading helpers', () => {
  test('omits message_thread_id for General topic sends', () => {
    expect(buildMessageThreadParams(TELEGRAM_GENERAL_TOPIC_ID)).toBeUndefined()
  })

  test('keeps non-General topic ids for sends', () => {
    expect(buildMessageThreadParams(42)).toEqual({ message_thread_id: 42 })
  })

  test('keeps General topic id for typing indicators', () => {
    expect(buildTypingThreadParams(TELEGRAM_GENERAL_TOPIC_ID)).toEqual({ message_thread_id: TELEGRAM_GENERAL_TOPIC_ID })
  })
})
