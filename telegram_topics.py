TELEGRAM_GENERAL_TOPIC_ID = 1


def normalize_forum_thread_id(message_thread_id: int | None, is_forum: bool | None) -> int | None:
    """Treat Telegram's General forum topic as thread 1 when the API omits it."""
    if message_thread_id is not None:
        return int(message_thread_id)
    if is_forum:
        return TELEGRAM_GENERAL_TOPIC_ID
    return None
