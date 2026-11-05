"""Live visibility, measured mind-changes, and the streaming bridge. No models, no network, no Node."""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import agent_bridge  # noqa: E402
import mindchange  # noqa: E402
from live import BUILD_PHASES, COUNCIL_PHASES, Live, Meter, Tracker, same_file, spoken_name  # noqa: E402


class FakeRoom:
    """Records everything the live layer tells the browser, and what it would have said aloud."""

    def __init__(self):
        self.sent, self.spoken = [], []

    async def send(self, obj):
        self.sent.append(obj)

    async def narrate(self, agent, text):
        self.spoken.append((agent, text))


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def tool(text, **kw):
    return {"kind": "tool", "tool": kw.pop("name", "Read"), "text": text, **kw}


class MeterTests(unittest.TestCase):
    def test_estimate_never_claims_done_until_finished(self):
        m = Meter(BUILD_PHASES)
        self.assertEqual(m.pct(), 0)
        m.set("execute", 5)  # absurd input is clamped
        self.assertLess(m.pct(), 99)
        for phase, _ in BUILD_PHASES:
            m.complete(phase)
        self.assertEqual(m.pct(), 99)  # only Live.finish() may say 100

    def test_progress_is_weighted_and_monotonic_within_a_phase(self):
        m = Meter(COUNCIL_PHASES)
        seen = []
        for frac in (0.0, 0.3, 0.6):
            m.set("investigate", frac)
            seen.append(m.pct())
        self.assertEqual(seen, sorted(seen))
        m.complete("recall")
        self.assertGreater(m.pct(), seen[-1] - 1)


class TrackerTests(unittest.TestCase):
    def test_counts_reads_and_distinct_edits(self):
        t = Tracker("ops", Clock())
        t.feed({"kind": "turn", "turn": 2, "maxTurns": 24})
        t.feed(tool("Reading a.ts", target="a.ts"))
        t.feed(tool("Reading a.ts", target="a.ts"))
        t.feed(tool("Editing b.ts", target="b.ts", edit=True, name="Edit"))
        msg = t.feed(tool("Editing b.ts", target="b.ts", edit=True, name="Edit"))
        self.assertEqual((msg["reads"], msg["edits"], msg["turn"], msg["max_turns"]), (1, 1, 2, 24))
        self.assertEqual(msg["tools"], 4)

    def test_new_route_restarts_turn_counting(self):
        t = Tracker("ops", Clock())
        t.feed({"kind": "turn", "turn": 24, "maxTurns": 24})
        t.feed({"kind": "route", "state": "try", "text": "Asking codex"})
        self.assertEqual((t.turn, t.max_turns, t.routes), (0, 0, 1))

    def test_first_edit_is_announced_once_per_file_and_reads_are_not(self):
        t = Tracker("ops", Clock())
        ev = tool("Editing src/agent-voice-bridge.ts", target="src/agent-voice-bridge.ts", edit=True, name="Edit")
        t.feed(ev)
        self.assertEqual(t.propose(ev), ("First change, in agent voice bridge.", False))
        again = tool("Editing src/agent-voice-bridge.ts", target="src/agent-voice-bridge.ts", edit=True, name="Edit")
        t.feed(again)
        self.assertIsNone(t.propose(again))
        read = tool("Reading x.ts", target="x.ts")
        t.feed(read)
        self.assertIsNone(t.propose(read))

    def test_fallbacks_are_urgent_and_name_the_provider(self):
        t = Tracker("ops", Clock())
        ev = {"kind": "route", "state": "failed", "provider": "claude", "text": "x"}
        t.feed(ev)
        text, urgent = t.propose(ev)
        self.assertTrue(urgent)
        self.assertIn("Claude", text)

    def test_silence_is_reported_once_then_resets_on_any_event(self):
        clock = Clock()
        t = Tracker("ops", clock)
        t.feed(tool("Running: npm test", target="npm test"))
        self.assertIsNone(t.propose())
        clock.t += 91
        said = t.propose()
        self.assertIsNotNone(said)
        self.assertTrue(said[1])
        self.assertIn("91 seconds", said[0])
        self.assertIsNone(t.propose(), "must not repeat itself every tick")
        t.feed(tool("Reading a.ts", target="a.ts"))
        clock.t += 91
        self.assertIsNotNone(t.propose())

    def test_periodic_summary_states_real_counts(self):
        clock = Clock()
        t = Tracker("ops", clock)
        t.feed(tool("Reading a.ts", target="a.ts"))
        t.feed(tool("Editing b.ts", target="b.ts", edit=True, name="Edit"))
        clock.t += 51
        t.last = clock.t - 1  # recent activity, so this is a summary and not a stall
        text, urgent = t.propose()
        self.assertEqual(text, "Still on it. 1 file read, 1 changed.")
        self.assertFalse(urgent)

    def test_commentary_uses_correct_plurals(self):
        from live import count
        self.assertEqual([count(0, "file"), count(1, "file"), count(2, "file")], ["0 files", "1 file", "2 files"])
        for n, want in ((1, "Still working. 1 action so far."), (3, "Still working. 3 actions so far.")):
            clock = Clock()
            t = Tracker("main", clock)
            for i in range(n):
                t.feed(tool("Searching x", name="Grep"))
            clock.t += 51
            t.last = clock.t - 1
            self.assertEqual(t.propose()[0], want)

    def test_report_vs_observed_edits(self):
        t = Tracker("ops", Clock())
        t.feed(tool("Editing src/a.ts", target="src/a.ts", edit=True, name="Edit"))
        t.feed(tool("Editing src/b.ts", target="src/b.ts", edit=True, name="Edit"))
        unseen, unreported = t.compare(["src\\a.ts", "src/never.ts"])
        self.assertEqual(unseen, ["src/never.ts"])
        self.assertEqual(unreported, ["src/b.ts"])

    def test_path_helpers(self):
        self.assertTrue(same_file("src\\a.ts", "./src/a.ts"))
        self.assertTrue(same_file("\u2026/very/long/src/a.ts", "src/a.ts"))
        self.assertFalse(same_file("src/a.ts", "src/b.ts"))
        self.assertFalse(same_file("", ""))
        self.assertEqual(spoken_name("src/agent-voice-bridge.ts"), "agent voice bridge")
        self.assertEqual(spoken_name("README.md"), "README")


class LiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_events_reach_the_browser_and_commentary_is_throttled(self):
        room, clock = FakeRoom(), Clock()
        live = Live(room, BUILD_PHASES, clock)
        await live.enter("execute", 1, "1 owner")
        async with live.following("ops") as on_event:
            await on_event({"kind": "turn", "turn": 3, "maxTurns": 40})
            await on_event(tool("Editing a.ts", target="a.ts", edit=True, name="Edit"))
            clock.t += 3
            await on_event(tool("Editing b.ts", target="b.ts", edit=True, name="Edit"))
            clock.t += 30
            await on_event(tool("Editing c.ts", target="c.ts", edit=True, name="Edit"))
        activity = [m for m in room.sent if m.get("type") == "activity"]
        self.assertEqual(activity[0]["turn"], 3)
        self.assertEqual(activity[-1]["kind"], "done")
        self.assertEqual([t for _, t in room.spoken], ["First change, in a.", "Now changing c."],
                         "second edit came 3s later and must not be spoken; third came after the gap")
        meters = [m for m in room.sent if m.get("type") == "meter"]
        self.assertTrue(meters and meters[-1]["pct"] < 100)

    async def test_urgent_news_may_interrupt_but_not_machine_gun(self):
        room, clock = FakeRoom(), Clock()
        live = Live(room, BUILD_PHASES, clock)
        async with live.following("ops") as on_event:
            await on_event({"kind": "route", "state": "failed", "provider": "claude", "text": "x"})
            clock.t += 2
            await on_event({"kind": "route", "state": "failed", "provider": "codex", "text": "y"})
            clock.t += 7
            await on_event({"kind": "route", "state": "failed", "provider": "gemini", "text": "z"})
        self.assertEqual(len(room.spoken), 2)

    async def test_finish_states_are_distinct(self):
        for state in ("complete", "failed", "cancelled"):
            room = FakeRoom()
            live = Live(room)
            await live.finish(state)
            last = room.sent[-1]
            self.assertTrue(last["final"])
            self.assertEqual(last["state"], state)
            self.assertEqual(last["failed"], state == "failed")
            self.assertEqual(last["pct"] == 100, state == "complete")

    async def test_cleanup_even_when_the_call_raises(self):
        room = FakeRoom()
        live = Live(room)
        with self.assertRaises(RuntimeError):
            async with live.following("ops"):
                raise RuntimeError("boom")
        self.assertNotIn("ops", live.running)
        self.assertEqual(room.sent[-2]["kind"], "done")


class MindChangeTests(unittest.TestCase):
    def test_claim_without_movement_is_not_a_changed_mind(self):
        a = mindchange.assess(0.80, "Keep the playwright cli wrapper", 0.80, "Keep the playwright cli wrapper as is", True)
        self.assertFalse(a["changed"])
        self.assertTrue(a["claimed"])
        s = mindchange.summarize({"research": a})
        self.assertEqual((s["changed_minds"], s["changed_minds_claimed"]), (0, 1))
        self.assertEqual(s["claimed_without_change"], ["research"])

    def test_real_movement_counts_even_if_unclaimed(self):
        a = mindchange.assess(0.90, "Keep the cli", 0.60, "Keep the cli", False)
        self.assertTrue(a["changed"])
        self.assertIn("0.90 -> 0.60", a["reasons"][0])
        s = mindchange.summarize({"ops": a})
        self.assertEqual(s["changed_without_claim"], ["ops"])

    def test_a_claimed_change_backed_by_a_real_rewrite_counts(self):
        a = mindchange.assess(0.8, "Retain the existing browser command line wrapper", 0.8,
                              "Replace everything with the MCP server immediately", True)
        self.assertTrue(a["changed"])
        self.assertFalse(a["reworded"])
        self.assertIn("claimed a change and rewrote", a["reasons"][0])

    def test_a_rewrite_nobody_claims_is_only_reworded(self):
        a = mindchange.assess(0.8, "Retain the existing browser command line wrapper", 0.8,
                              "Replace everything with the MCP server immediately", False)
        self.assertEqual((a["changed"], a["reworded"], a["reasons"]), (False, True, []))
        s = mindchange.summarize({"ops": a})
        self.assertEqual((s["changed_minds"], s["reworded_agents"], s["mind_rule"]), (0, ["ops"], 2))

    def test_the_first_real_summit_was_not_a_changed_mind(self):
        # Ops, run 9a7edfa0, copied from its transcripts: same design, same call sites, detail refined, said changed_mind=false.
        take = ("Apply Design B: wrap the two `asyncio.to_thread` calls for preflight (council.py:414) and gate (council.py:477) "
                "with the already-working `self._progress()` method. This is a 2-line change to one file. Design A (streaming "
                "subprocess output) is larger, riskier on Windows, and delivers nothing useful because tsc, node --check, and "
                "py_compile are batch-output tools that produce no incremental lines during compilation.")
        revised = ("Design B: wrap the preflight asyncio.to_thread at council.py:414 and the gate asyncio.to_thread at "
                   "council.py:477 with self._progress(), and delete the now-dead manual gate build_progress message at lines "
                   "473-474. Four lines changed in council.py only. No build.py edits, no new dependencies, fully reversible.")
        a = mindchange.assess(0.95, take, 0.92, revised, False)
        self.assertLess(a["similarity"], mindchange.WORDING_SIMILARITY, "the old rule would have called this a change")
        self.assertEqual((a["changed"], a["reworded"]), (False, True))

    def test_a_big_confidence_move_still_counts_without_any_claim_or_rewrite(self):
        a = mindchange.assess(0.92, "Keep it", 0.70, "Keep it", False)
        self.assertEqual((a["changed"], a["reworded"]), (True, False))

    def test_toolless_answer_cannot_talk_a_verified_position_down(self):
        a = mindchange.assess(0.91, "Keep it", 0.68, "Keep it", True, has_tools=False)
        self.assertTrue(a["capped"])
        self.assertAlmostEqual(a["after"], 0.81)
        self.assertFalse(a["changed"], "a 0.10 drop is below the changed-mind threshold")

    def test_toolless_small_or_upward_moves_pass_through(self):
        for claimed in (0.85, 0.95):
            a = mindchange.assess(0.9, "x y z", claimed, "x y z", False, has_tools=False)
            self.assertFalse(a["capped"])
            self.assertAlmostEqual(a["after"], claimed)

    def test_tooled_answer_is_trusted_to_move_far(self):
        a = mindchange.assess(0.91, "Keep it", 0.40, "Keep it", True, has_tools=True)
        self.assertFalse(a["capped"])
        self.assertTrue(a["changed"])
        self.assertAlmostEqual(a["after"], 0.40)


class BridgeStreamTests(unittest.IsolatedAsyncioTestCase):
    def test_parse_line_separates_progress_answers_and_log_noise(self):
        self.assertEqual(agent_bridge.parse_line('{"event":"activity","kind":"tool"}')[0], "activity")
        self.assertEqual(agent_bridge.parse_line('{"ok":true,"text":"hi"}')[0], "reply")
        self.assertEqual(agent_bridge.parse_line('{"level":30,"msg":"pino log line"}'), (None, None))
        for junk in ("", "plain text", "{broken", "[1,2]", None):
            self.assertEqual(agent_bridge.parse_line(junk), (None, None))

    async def test_reader_forwards_activity_in_order_and_keeps_the_last_answer(self):
        reader = asyncio.StreamReader()
        for line in ('{"level":30,"msg":"noise"}', '{"event":"activity","text":"one"}',
                     '{"ok":false,"text":"first"}', '{"event":"activity","text":"two"}', '{"ok":true,"text":"final"}'):
            reader.feed_data((line + "\n").encode())
        reader.feed_eof()
        got, found = [], {}

        async def on_event(ev):
            got.append(ev["text"])

        await agent_bridge._read_stdout(reader, on_event, found)
        self.assertEqual(got, ["one", "two"])
        self.assertEqual(found["reply"]["text"], "final")

    async def test_a_broken_observer_never_loses_the_answer(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'{"event":"activity","text":"x"}\n{"ok":true,"text":"answer"}\n')
        reader.feed_eof()
        found = {}

        async def broken(ev):
            raise RuntimeError("browser went away")

        await agent_bridge._read_stdout(reader, broken, found)
        self.assertEqual(found["reply"]["text"], "answer")

    async def test_a_very_long_reply_line_is_not_a_stream_error(self):
        reader = asyncio.StreamReader(limit=agent_bridge.STREAM_LIMIT)
        big = '{"ok":true,"text":"' + "x" * 300_000 + '"}\n'
        reader.feed_data(big.encode())
        reader.feed_eof()
        found = {}
        await agent_bridge._read_stdout(reader, None, found)
        self.assertEqual(len(found["reply"]["text"]), 300_000)


if __name__ == "__main__":
    unittest.main()
