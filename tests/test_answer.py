"""A direct question to one agent (typed or spoken) streams its activity like a council run does.

Without that stream the page heard nothing while the agent worked, so a perfectly healthy tool run showed QUIET and then
STALLED. Agent calls are stubbed: nothing here starts a model or spends money.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import server  # noqa: E402
from websockets.exceptions import ConnectionClosedOK  # noqa: E402


class FakeSocket:
    def __init__(self):
        self.out = []

    async def send(self, data):
        self.out.append(data)


class AnswerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ws = FakeSocket()
        self.session = server.Session(self.ws)
        self.saved = (server.ab.ask, server.ab.record)

        async def record(**kw):
            return {"ok": True}

        server.ab.record = record

    async def asyncTearDown(self):
        server.ab.ask, server.ab.record = self.saved
        self.session.close()

    def sent(self):
        import json
        return [json.loads(x) for x in self.ws.out if isinstance(x, str)]

    async def test_activity_reaches_the_page_while_the_agent_works(self):
        async def ask(agent, prompt, *, on_event=None, **kw):
            self.assertIsNotNone(on_event, "the call must carry the activity listener")
            await on_event({"kind": "turn", "turn": 1, "max_turns": 12})
            await on_event({"kind": "tool", "tool": "Bash", "text": "Running a command"})
            return {"ok": True, "text": "All good.", "provider": "claude", "model": "sonnet", "attempts": []}

        server.ab.ask = ask
        await self.session.answer("main", "check my PC")
        kinds = [(m.get("type"), m.get("kind")) for m in self.sent()]
        self.assertIn(("activity", "tool"), kinds)
        self.assertIn(("activity", "done"), kinds, "the agent's row is closed when the call ends")
        self.assertIn(("activity", "result"), kinds)
        self.assertTrue(any(m.get("final") for m in self.sent() if m.get("type") == "meter"))

    async def test_the_route_line_learns_which_provider_answered(self):
        async def ask(agent, prompt, *, on_event=None, **kw):
            return {"ok": True, "text": "Hi.", "provider": "codex", "model": "gpt-x", "attempts": [{"provider": "codex"}]}

        server.ab.ask = ask
        await self.session.answer("ops", "hello")
        route = [m for m in self.sent() if m.get("type") == "provider"]
        self.assertEqual([(m["agent_id"], m["provider"], m["model"]) for m in route], [("ops", "codex", "gpt-x")])

    async def test_a_failed_answer_is_reported_as_failed_not_complete(self):
        async def ask(agent, prompt, *, on_event=None, **kw):
            return {"ok": False, "text": "all routes failed"}

        server.ab.ask = ask
        await self.session.answer("main", "hello")
        final = [m for m in self.sent() if m.get("type") == "meter" and m.get("final")]
        self.assertEqual([m["state"] for m in final], ["failed"])
        self.assertTrue(any(m.get("kind") == "error" for m in self.sent()))


class DeadSocket:
    async def send(self, data):
        raise ConnectionClosedOK(None, None)


class BroadcastTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_dead_tab_cannot_break_a_voice_change_for_the_live_one(self):
        live_ws = FakeSocket()
        live, dead = server.Session(live_ws), server.Session(DeadSocket())
        saved = (server.casting.set_voice, server.casting.casting_message, set(server.SESSIONS))
        server.casting.set_voice = lambda agent, voice: {}
        server.casting.casting_message = lambda: {"type": "casting", "voices": [], "current": {}}
        server.SESSIONS.clear()
        server.SESSIONS.update({dead, live})  # the dead tab may come first in any order
        try:
            await live.change_voice("main", "bm_george")  # must not raise, must still reach the live tab
        finally:
            server.casting.set_voice, server.casting.casting_message = saved[0], saved[1]
            server.SESSIONS.clear()
            server.SESSIONS.update(saved[2])
            live.close()
            dead.close()
        import json
        self.assertTrue(any(json.loads(x).get("type") == "casting" for x in live_ws.out if isinstance(x, str)))


if __name__ == "__main__":
    unittest.main()
