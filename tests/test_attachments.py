"""Files attached to a War Room message: the pure rules, and what the server does with them (no models, no network)."""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import attachments  # noqa: E402
import server  # noqa: E402

GOOD = "1731000000000-a1b2c3_shot.png"


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send(self, data):
        self.sent.append(json.loads(data) if isinstance(data, str) else data)


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / GOOD).write_bytes(b"png")

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_saved_upload_resolves_to_its_name_and_path(self):
        self.assertEqual(attachments.resolve([GOOD], self.dir), ([("shot.png", str(self.dir / GOOD))], ""))
        self.assertEqual(attachments.resolve(None, self.dir), ([], ""))
        self.assertEqual(attachments.resolve([], self.dir), ([], ""))

    def test_only_ids_this_system_made_are_accepted_so_a_client_cannot_name_a_path(self):
        for bad in ("../../.env", "C:\\Windows\\win.ini", "/etc/passwd", "shot.png", "1731000000000-a1b2c3_../x", "1731000000000-a1b2c3_a/b", 7, None):
            files, problem = attachments.resolve([bad], self.dir)
            self.assertEqual((files, problem), ([], "that attachment id is not valid"), repr(bad))
        self.assertEqual(attachments.resolve("shot.png", self.dir)[1], "attachments must be a list of upload ids")

    def test_a_missing_file_and_too_many_files_say_what_to_do(self):
        gone = "1731000000001-ffffff_old.pdf"
        self.assertIn("old.pdf is no longer available", attachments.resolve([gone], self.dir)[1])
        self.assertIn("attach it again", attachments.resolve([gone], self.dir)[1])
        self.assertEqual(attachments.resolve([GOOD] * 6, self.dir)[1], "at most 5 files per message")

    def test_block_wording_is_pinned_to_the_node_side(self):
        # src/attach-format.ts builds this exact text (tests/attachments.test.mjs pins the same literal).
        self.assertEqual(attachments.block([("shot.png", "C:\\up\\x_shot.png"), ("a.pdf", "C:\\up\\y_a.pdf")]),
                         "\n\n[Attached files: the user attached these. Open each with your file tools (images and PDFs too) "
                         "before you answer.]\n- shot.png: C:\\up\\x_shot.png\n- a.pdf: C:\\up\\y_a.pdf\n[end of attached files]")
        self.assertEqual(attachments.block([]), "")


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = attachments.UPLOADS_DIR, attachments.resolve.__defaults__
        attachments.resolve.__defaults__ = (Path(self.tmp.name),)  # the default `directory`
        (Path(self.tmp.name) / GOOD).write_bytes(b"png")
        self.ws = FakeSocket()
        self.session = server.Session(self.ws)
        self.calls = []

        async def handle_text(text, kind="text", attached=""):
            self.calls.append((text, kind, attached))
        self.session.handle_text = handle_text

    async def asyncTearDown(self):
        self.session.close()
        attachments.resolve.__defaults__ = self.saved[1]
        self.tmp.cleanup()

    async def test_the_message_and_its_files_travel_together(self):
        await self.session.dispatch({"type": "text", "text": "what is in this?", "attachments": [GOOD]})
        text, kind, attached = self.calls[0]
        self.assertEqual((text, kind), ("what is in this?", "text"))
        self.assertIn(f"- shot.png: {Path(self.tmp.name) / GOOD}", attached)
        await self.session.dispatch({"type": "summit", "text": "should we ship?", "attachments": [GOOD]})
        self.assertEqual(self.calls[1][1], "summit")
        self.assertIn("shot.png", self.calls[1][2])

    async def test_a_plain_message_is_unchanged(self):
        await self.session.dispatch({"type": "text", "text": "hello"})
        self.assertEqual(self.calls, [("hello", "text", "")])

    async def test_a_bad_attachment_is_refused_out_loud_and_nothing_runs(self):
        await self.session.dispatch({"type": "text", "text": "look", "attachments": ["../../.env"]})
        self.assertEqual(self.calls, [])
        said = [m for m in self.ws.sent if isinstance(m, dict) and m.get("agent_id") == "war-room"]
        self.assertEqual(said[-1]["text"], "Not sent: that attachment id is not valid.")


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    """The agent is told where the files are; the transcript and the memory lookup see only what the user typed."""

    async def asyncSetUp(self):
        self.session = server.Session(FakeSocket())
        self.asked, self.recorded = [], []

        async def ask(agent, prompt, **kw):
            self.asked.append((agent, prompt, kw))
            return {"ok": True, "text": "a reply", "provider": "claude"}

        async def record(**kw):
            self.recorded.append(kw)
        self.real = server.ab.ask, server.ab.record
        server.ab.ask, server.ab.record = ask, record

    async def asyncTearDown(self):
        server.ab.ask, server.ab.record = self.real
        self.session.close()

    async def test_the_prompt_carries_the_block_but_memory_and_history_do_not(self):
        block = attachments.block([("shot.png", "C:\\up\\x_shot.png")])
        await self.session.answer("ops", "what is this?", block)
        agent, prompt, kw = self.asked[0]
        self.assertIn("User said: what is this?\n\n[Attached files:", prompt)
        self.assertIn("- shot.png: C:\\up\\x_shot.png", prompt)
        self.assertEqual(kw["memory_query"], "what is this?", "file paths must not skew the memory search")
        self.assertEqual(self.session.history[0], ("you", "what is this?"))
        await asyncio.sleep(0)
        self.assertEqual(self.recorded[0]["question"], "what is this?")

    async def test_no_files_no_change_to_the_prompt(self):
        await self.session.answer("ops", "hi")
        self.assertIn("User said: hi\n\n", self.asked[0][1])
        self.assertNotIn("Attached", self.asked[0][1])


if __name__ == "__main__":
    unittest.main()
