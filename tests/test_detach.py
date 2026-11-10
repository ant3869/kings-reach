"""Reloading or closing the War Room page must not cancel a council, a build or a reply.

Work belongs to the session, not to the socket. A tab that leaves mid-run detaches its session; the next tab takes it over
and is replayed what it missed. Agent calls are stubbed: nothing here starts a model or spends money.
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import server  # noqa: E402


class Tab:
    """A browser tab as handle_client sees it: something to send to, and an inbox it iterates over."""

    def __init__(self, slow=False):
        self.out, self.inbox, self.slow = [], asyncio.Queue(), slow

    async def send(self, data):
        if self.slow:
            await asyncio.sleep(0)  # hand control to whoever else is sending
        self.out.append(data)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item

    def say(self, **payload):
        self.inbox.put_nowait(json.dumps(payload))

    def leave(self):
        self.inbox.put_nowait(None)

    def seen(self):
        return [json.loads(x) for x in self.out if isinstance(x, str)]

    def lines(self):
        return [m["text"] for m in self.seen() if "text" in m and "agent_id" in m]


async def until(predicate, seconds=3):
    for _ in range(int(seconds / 0.01)):
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return False


class DetachTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = (server.ab.ask, server.ab.record, server.VOICE.info, server.casting.casting_message,
                      server.latest_build_card, list(server.DETACHED), set(server.SESSIONS))
        self.release, self.started, self.cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        server.DETACHED.clear()
        server.SESSIONS.clear()

        async def ask(agent, prompt, *, on_event=None, **kw):
            self.started.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
            return {"ok": True, "text": "All done.", "provider": "claude", "model": "m", "attempts": []}

        async def record(**kw):
            return {"ok": True}

        server.ab.ask, server.ab.record = ask, record
        server.VOICE.info = lambda: {"type": "voice", "state": "ready"}
        server.casting.casting_message = lambda: {"type": "casting", "voices": [], "current": {}}
        server.latest_build_card = lambda: None
        self.handlers = []

    async def asyncTearDown(self):
        self.release.set()
        await asyncio.sleep(0.05)  # let a finished reply's memory write run instead of being cancelled unstarted
        for handler in self.handlers:
            handler.cancel()
        for session in list(server.DETACHED):
            session.close()
        (server.ab.ask, server.ab.record, server.VOICE.info, server.casting.casting_message, server.latest_build_card) = self.saved[:5]
        server.DETACHED[:] = self.saved[5]
        server.SESSIONS.clear()
        server.SESSIONS.update(self.saved[6])

    def connect(self, tab):
        handler = asyncio.ensure_future(server.handle_client(tab))
        self.handlers.append(handler)
        return handler

    async def start_work_then_reload(self):
        """Tab one asks Ops something slow, then reloads. Returns tab two, already connected."""
        one = Tab()
        gone = self.connect(one)
        one.say(type="text", text="hey Ops, status?")
        self.assertTrue(await until(self.started.is_set), "the agent call began")
        one.leave()
        await gone
        return one, Tab()

    async def test_reloading_the_page_does_not_cancel_the_work(self):
        one, _ = await self.start_work_then_reload()
        self.assertFalse(self.cancelled.is_set(), "the old behaviour: closing the tab cancelled the agent")
        self.assertEqual(len(server.DETACHED), 1, "the session waits for the next tab")
        self.assertEqual(len(server.DETACHED[0].tasks), 1)
        before = len(one.out)
        self.release.set()
        self.assertTrue(await until(lambda: not server.DETACHED[0].tasks), "the work finished without its tab")
        self.assertEqual(len(one.out), before, "nothing is written to a tab that has left")

    async def test_the_next_tab_takes_over_and_is_caught_up_then_gets_the_answer(self):
        _, two = await self.start_work_then_reload()
        gone = self.connect(two)
        self.assertTrue(await until(lambda: any("Reconnected" in t for t in two.lines())))
        replay = two.seen()
        self.assertEqual(replay[0], {"type": "resume"}, "the page is told to clear its transcript before the replay arrives")
        self.assertIn({"type": "you", "kind": "text", "text": "hey Ops, status?", "files": []}, replay, "the page sees its own question too")
        self.assertTrue(any(m.get("type") == "thinking" and m.get("on") and m.get("agent_id") == "ops" for m in replay),
                        "the page learns the agent is still working")
        self.assertEqual(server.DETACHED, [], "the session is attached again")
        self.release.set()
        self.assertTrue(await until(lambda: "All done." in two.lines()), "the answer arrives in the new tab")
        two.leave()
        await gone

    async def test_a_message_with_files_is_replayed_with_their_names_not_their_paths(self):
        one = Tab()
        gone = self.connect(one)
        saved = server.attachments.resolve
        server.attachments.resolve = lambda ids: ([("shot.png", "C:\\\\up\\\\x_shot.png")], "")
        try:
            one.say(type="summit", text="should we ship?", attachments=["1731000000000-a1b2c3_shot.png"])
            await until(lambda: server.DETACHED or self.started.is_set() or any(s.journal for s in server.SESSIONS))
            await asyncio.sleep(0.05)
            session = next(iter(server.SESSIONS))
            you = [m for m in session.journal if m.get("type") == "you"]
            self.assertEqual(you, [{"type": "you", "kind": "summit", "text": "should we ship?", "files": ["shot.png"]}])
            self.assertNotIn("C:", json.dumps(you), "a path never goes to the page")
        finally:
            server.attachments.resolve = saved
            one.leave()
            await gone

    async def test_greetings_are_not_replayed_so_a_second_reload_shows_one_welcome(self):
        one, two = await self.start_work_then_reload()
        gone = self.connect(two)
        await until(lambda: any("Reconnected" in t for t in two.lines()))
        two.leave()
        await gone
        three = Tab()
        self.connect(three)
        await until(lambda: any("Reconnected" in t for t in three.lines()))
        welcomes = [t for t in three.lines() if t.startswith(("Reconnected", "Welcome to the War Room"))]
        self.assertEqual(len(welcomes), 1, welcomes)

    async def test_cancel_from_the_new_tab_stops_the_work_that_survived(self):
        _, two = await self.start_work_then_reload()
        gone = self.connect(two)
        await until(lambda: any("Reconnected" in t for t in two.lines()))
        two.say(type="cancel")
        self.assertTrue(await until(self.cancelled.is_set), "Cancel still stops the agent")
        self.assertTrue(await until(lambda: any(m.get("type") == "cancel_ack" and m.get("stopped", 0) >= 1 for m in two.seen())))
        self.assertTrue(await until(lambda: "Reply cancelled." in two.lines()))
        two.leave()
        await gone

    async def test_an_answer_that_arrives_while_nobody_watches_is_waiting_for_the_next_tab(self):
        await self.start_work_then_reload()
        self.release.set()
        self.assertTrue(await until(lambda: server.DETACHED and not server.DETACHED[0].tasks), "the work finished")
        self.assertEqual(len(server.DETACHED), 1, "the result is kept, not thrown away")
        two = Tab()
        gone = self.connect(two)
        self.assertTrue(await until(lambda: "All done." in two.lines()), "a page opened afterwards still sees the answer")
        self.assertEqual(server.DETACHED, [])
        two.leave()
        await gone

    async def test_but_a_finished_session_nobody_collects_is_dropped(self):
        saved, server.RETIRE_AFTER_S = server.RETIRE_AFTER_S, 0.05
        try:
            await self.start_work_then_reload()
            self.release.set()
            self.assertTrue(await until(lambda: not server.DETACHED), "kept for a while, not forever")
        finally:
            server.RETIRE_AFTER_S = saved

    async def test_a_tab_that_leaves_with_nothing_running_is_closed_as_before(self):
        one = Tab()
        gone = self.connect(one)
        await until(lambda: any("Welcome" in t for t in one.lines()))
        one.leave()
        await gone
        self.assertEqual(server.DETACHED, [])
        self.assertEqual(server.SESSIONS, set())

    async def test_a_message_sent_during_catch_up_arrives_once_and_in_order(self):
        session = server.Session(Tab())
        session.detach()
        server.DETACHED.clear()
        await session.send({"agent_id": "ops", "text": "first"})
        await session.send({"agent_id": "ops", "text": "second"})
        tab = Tab(slow=True)  # every write yields, so the live message below really does race the replay
        catching_up = asyncio.ensure_future(session.attach(tab))
        await asyncio.sleep(0)
        await session.send({"agent_id": "ops", "text": "third"})
        await catching_up
        self.assertEqual(tab.lines(), ["first", "second", "third"])
        session.close()

    async def test_ping_says_whether_work_is_running_even_after_its_tab_left(self):
        self.assertEqual(server.busy_tasks(), 0)
        one, two = await self.start_work_then_reload()
        self.assertEqual(server.busy_tasks(), 1, "a restart script can tell that a run is still going")
        gone = self.connect(two)
        two.say(type="ping")
        self.assertTrue(await until(lambda: any(m.get("pong") for m in two.seen())))
        self.assertEqual([m["busy"] for m in two.seen() if m.get("pong")], [1])
        self.release.set()
        await until(lambda: server.busy_tasks() == 0)
        self.assertEqual(server.busy_tasks(), 0)
        two.leave()
        await gone

    async def test_only_what_a_page_needs_is_remembered(self):
        keep, drop = server.keep_for_replay, lambda m: not server.keep_for_replay(m)
        self.assertTrue(keep({"agent_id": "ops", "text": "hi", "kind": "reply"}))
        for kind in ("stage", "thinking", "activity", "meter", "provider", "build_result"):
            self.assertTrue(keep({"type": kind}), kind)
        self.assertFalse(keep({"type": "resume"}), "the marker is sent by attach(), never stored")
        self.assertTrue(drop({"ok": True, "pong": "council-v7"}))
        self.assertTrue(drop({"type": "voice"}))
        self.assertTrue(drop({"type": "casting"}))
        self.assertTrue(drop({"type": "cancel_ack", "stopped": 1}))
        self.assertTrue(drop(b"audio bytes"))

    async def test_the_journal_is_bounded(self):
        session = server.Session(Tab())
        for n in range(server.JOURNAL_LIMIT + 50):
            await session.send({"type": "activity", "n": n})
        self.assertEqual(len(session.journal), server.JOURNAL_LIMIT)
        self.assertEqual(session.journal[-1]["n"], server.JOURNAL_LIMIT + 49, "it keeps the newest")
        session.close()


if __name__ == "__main__":
    unittest.main()
