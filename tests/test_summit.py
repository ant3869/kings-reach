"""Council.deliberate() end to end with every agent stubbed: provenance, tool-less confidence cap, measured minds.

Ledger, verdict files and archive are redirected to a temp dir: this never touches store/ or the real history.
"""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import council  # noqa: E402
from fakes import Room  # noqa: E402

PATCHED = ("VERDICT_FILE", "VERDICT_JSON", "VERDICT_ARCHIVE_DIR", "RUNS_FILE", "DEBATE_ROUNDS")


class SummitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        self.saved = {k: getattr(council, k) for k in PATCHED}
        council.VERDICT_FILE, council.VERDICT_JSON = tmp / "v.md", tmp / "v.json"
        council.VERDICT_ARCHIVE_DIR, council.RUNS_FILE, council.DEBATE_ROUNDS = tmp / "verdicts", tmp / "runs.jsonl", 1
        self.saved_ab = (council.ab.ask, council.ab.record, council.ab.recall)
        self.prompts = {}
        self.ops_has_tools, self.fail_debate_for = False, None

        def take(conf, rec):
            return {"spoken": "s", "recommendation": rec, "findings": ["f"], "evidence": ["e"], "risks": ["r"], "confidence": conf}

        async def ask(agent, prompt, *, schema=None, on_event=None, **kw):
            if schema is council.PLAN:
                data = {"spoken": "go", "objective": "obj", "success_criteria": ["c"], "assignments": [
                    {"agent": "research", "task": "check", "tools_required": True},
                    {"agent": "ops", "task": "check", "tools_required": False}]}
                tools = True
            elif schema is council.TAKE:
                data = take(0.91, "Keep the cli wrapper") if agent == "research" else take(0.80, "Keep the cli wrapper too")
                tools = True if agent == "research" else self.ops_has_tools
            elif schema is council.VERDICT:
                self.prompts["verdict"] = prompt
                data = {"spoken": "v", "verdict": "keep it", "decided_by": ["research"], "dissent": [], "success_metrics": ["m"],
                        "confidence": 0.84, "plan": [{"step": "do", "owner": "ops", "done_when": "done"}]}
                tools = True
            else:  # a debate answer; schema is built per agent
                other = "ops" if agent == "research" else "research"
                same = "Keep the cli wrapper" if agent == "research" else "Keep the cli wrapper too"
                data = {"spoken": "d", "challenges": [{"target": other, "issue": "why"}], "revised_recommendation": same,
                        "changed_mind": True, "confidence": 0.62 if agent == "research" else 0.40}
                tools = True if agent == "research" else self.ops_has_tools
                if agent == self.fail_debate_for:
                    return {"ok": False, "text": "boom", "provider": "claude", "hasTools": True}
            return {"ok": True, "data": data, "provider": "claude" if tools else "chatgpt", "hasTools": tools, "costUsd": 0.01}

        async def record(**kw):
            return {"memories": 1, "hive": 2}

        async def recall(q):
            return "(nothing)"

        council.ab.ask, council.ab.record, council.ab.recall = ask, record, recall

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(council, k, v)
        council.ab.ask, council.ab.record, council.ab.recall = self.saved_ab
        self.tmp.cleanup()

    async def convene(self):
        room = Room()
        data = await council.Council(room).deliberate("should we keep the cli wrapper?")
        return room, data

    async def test_a_toolless_debate_cannot_talk_a_verified_position_down(self):
        _, data = await self.convene()
        research, ops = data["mind_changes"]["research"], data["mind_changes"]["ops"]
        self.assertEqual((research["after"], research["capped"]), (0.62, False), "a tooled seat may move freely")
        self.assertTrue(ops["capped"])
        self.assertAlmostEqual(ops["after"], 0.70)
        self.assertAlmostEqual(data["confidence"]["ops"][1], 0.70, msg="the recorded confidence is the guarded one")

    async def test_changed_minds_is_measured_and_the_claim_is_kept_beside_it(self):
        _, data = await self.convene()
        self.assertEqual(data["changed_minds"], 1)          # research moved 0.29; ops was capped to a 0.10 move
        self.assertEqual(data["changed_minds_claimed"], 2)  # both ticked the box
        self.assertEqual(data["claimed_without_change"], ["ops"])
        self.assertEqual(data["changed_minds_agents"], ["research"])

    async def test_the_ledger_row_records_which_mind_rule_measured_it(self):
        _, data = await self.convene()
        self.assertEqual(data["mind_rule"], 2, "old rows (rule 1) counted any rewrite; this tags the new ones apart")
        self.assertEqual(data["reworded_agents"], [])

    async def test_a_reworded_but_unclaimed_answer_is_not_a_changed_mind(self):
        original = council.ab.ask

        async def ask(agent, prompt, *, schema=None, **kw):
            r = await original(agent, prompt, schema=schema, **kw)
            if r.get("ok") and agent == "research" and schema not in (council.PLAN, council.TAKE, council.VERDICT):
                r["data"].update(changed_mind=False, confidence=0.88,
                                 revised_recommendation="Fully different words about an identical position entirely")
            return r

        council.ab.ask = ask
        _, data = await self.convene()
        self.assertNotIn("research", data["changed_minds_agents"])
        self.assertEqual(data["reworded_agents"], ["research"])
        self.assertTrue(data["mind_changes"]["research"]["reworded"])

    async def test_toolless_take_is_flagged_everywhere_it_matters(self):
        room, data = await self.convene()
        self.assertEqual(data["takes_without_tools"], ["ops"])
        self.assertIn("NO TOOLS: unverified", self.prompts["verdict"], "Main must be told which position is unverified")
        said = [t for a, t in room.said if a == "ops"]
        self.assertTrue(any("without tools" in t for t in said))

    async def test_a_seat_with_tools_is_not_flagged(self):
        self.ops_has_tools = True
        _, data = await self.convene()
        self.assertEqual(data["takes_without_tools"], [])
        self.assertFalse(data["mind_changes"]["ops"]["capped"])
        self.assertAlmostEqual(data["mind_changes"]["ops"]["after"], 0.40)

    async def test_the_scoreboard_message_carries_the_measured_fields(self):
        room, _ = await self.convene()
        m = room.metrics()[-1]
        for key in ("mind_changes", "changed_minds", "changed_minds_claimed", "takes_without_tools"):
            self.assertIn(key, m)
        self.assertEqual(room.final()[0]["state"], "complete")

    async def test_a_failed_debate_answer_leaves_the_original_position_standing(self):
        self.fail_debate_for = "research"
        _, data = await self.convene()
        self.assertNotIn("research", data["mind_changes"])
        self.assertEqual(data["confidence"]["research"], [0.91, 0.91])
        self.assertEqual(data["debate_failed_specialists"], ["research"])

    async def test_verdict_files_went_to_the_temp_dir_and_are_valid(self):
        await self.convene()
        saved = json.loads(council.VERDICT_JSON.read_text(encoding="utf-8"))
        self.assertEqual(saved["verdict"], "keep it")
        self.assertNotEqual(council.RUNS_FILE.parent.name, "store")

    async def test_cancelling_mid_summit_reports_cancelled(self):
        room = Room()
        task = asyncio.ensure_future(council.Council(room).deliberate("q"))

        async def slow(*a, **kw):
            await asyncio.sleep(30)

        council.ab.ask = slow
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(room.final()[0]["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
