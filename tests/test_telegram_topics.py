import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from telegram_topics import TELEGRAM_GENERAL_TOPIC_ID, normalize_forum_thread_id


class TelegramTopicsTest(unittest.TestCase):
    def test_keeps_explicit_topic_id(self) -> None:
        self.assertEqual(normalize_forum_thread_id(42, True), 42)

    def test_general_topic_defaults_to_one_for_forum_chat(self) -> None:
        self.assertEqual(normalize_forum_thread_id(None, True), TELEGRAM_GENERAL_TOPIC_ID)

    def test_non_forum_chat_without_thread_stays_none(self) -> None:
        self.assertIsNone(normalize_forum_thread_id(None, False))


if __name__ == "__main__":
    unittest.main()
