"""The per-run spend limit (COUNCIL_MAX_COST_USD): the pure rules, and a real Council and Build stopped by it.

Every agent is stubbed with a fixed cost per call. Ledger, verdict and build-state files go to a temp dir: this never touches store/.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import council  # noqa: E402
import spend  # noqa: E402
from fakes import Room  # noqa: E402


class SettingTests(unittest.TestCase):
    def test_blank_and_zero_mean_off_without_a_complaint(self):
        for raw in (None, "", "  ", "0", "0.0", "$0"):
            self.assertEqual(spend.setting(raw), (None, ""), repr(raw))

    def test_a_positive_number_is_the_limit_dollar_sign_allowed(self):
        self.assertEqual(spend.setting("2.5"), (2.5, ""))
        self.assertEqual(spend.setting(" $3 "), (3.0, ""))

    def test_a_value_that_cannot_be_used_says_so_instead_of_silently_meaning_no_limit(self):
        for raw in ("2usd", "abc", "-1", "nan", "inf"):
            limit, note = spend.setting(raw)
            self.assertIsNone(limit, raw)
            self.assertIn("NO spend limit", note, raw)
            self.assertIn(raw, note)

    def test_reaching_the_limit_exactly_stops(self):
        self.assertTrue(spend.over(2.0, 2.0))
        self.assertFalse(spend.over(1.99, 2.0))
        self.assertFalse(spend.over(99, None), "no limit never stops anything")

    def test_the_message_is_honest_that_only_reported_costs_count(self):
        text = spend.stopped_message(2.31, 2.0, "before the debate")
        for want in ("$2.31", "$2.00", "before the debate", "providers report", "may be higher"):
            self.assertIn(want, text)


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        names = ("VERDICT_FILE", "VERDICT_JSON", "VERDICT_ARCHIVE_DIR", "RUNS_FILE", "DEBATE_ROUNDS", "COUNCIL_DIR",
                 "BUILD_STATE_JSON", "COST_LIMIT_RAW")
        self.saved = {k: getattr(council, k) for k in names}
        self.saved_ab = (council.ab.ask, council.ab.record, council.ab.recall)
        self.saved_build = (council.build.preflight, council.build.gate)
        council.VERDICT_FILE, council.VERDICT_JSON = tmp / "v.md", tmp / "v.json"
        council.VERDICT_ARCHIVE_DIR, council.RUNS_FILE, council.DEBATE_ROUNDS = tmp / "verdicts", tmp / "runs.jsonl", 1
        council.COUNCIL_DIR, council.BUILD_STATE_JSON, council.COST_LIMIT_RAW = tmp / "council", tmp / "build-state.json", ""
        self.cost, self.asked = 0.6, []  # dollars every stubbed call reports

        async def record(**kw):
            return {"memories": 0, "hive": 0}

        async def recall(q):
            return "(nothing)"

        council.ab.record, council.ab.recall = record, recall
        council.build.preflight = lambda py: {"ok": True, "output": "clean"}
        council.build.gate = lambda files, py: {"ok": True, "output": "gate ok"}

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(council, k, v)
        council.ab.ask, council.ab.record, council.ab.recall = self.saved_ab
        council.build.preflight, council.build.gate = self.saved_build
        self.tmp.cleanup()

    def ledger(self):
        return [json.loads(line) for line in council.RUNS_FILE.read_text().splitlines()] if council.RUNS_FILE.exists() else []


class SummitLimitTests(Base):
    def setUp(self):
        super().setUp()

        async def ask(agent, prompt, *, schema=None, on_event=None, **kw):
            self.asked.append(agent)
            if schema is council.PLAN:
                data = {"spoken": "go", "objective": "obj", "success_criteria": ["c"], "assignments": [
                    {"agent": a, "task": "check", "tools_required": False} for a in ("research", "ops")]}
            elif schema is council.TAKE:
                data = {"spoken": "s", "recommendation": "keep it", "findings": ["f"], "evidence": ["e"], "risks": ["r"], "confidence": 0.8}
            elif schema is council.VERDICT:
                data = {"spoken": "v", "verdict": "keep it", "decided_by": ["research"], "dissent": [], "success_metrics": ["m"],
                        "confidence": 0.8, "plan": [{"step": "do", "owner": "ops", "done_when": "done"}]}
            else:
                data = {"spoken": "d", "challenges": [{"target": "ops", "issue": "why"}], "revised_recommendation": "keep it",
                        "changed_mind": False, "confidence": 0.8}
            return {"ok": True, "data": data, "provider": "claude", "hasTools": True, "costUsd": self.cost}

        council.ab.ask = ask

    async def convene(self, limit):
        room = Room()
        c = council.Council(room)
        c.cost_limit = limit
        return room, await c.deliberate("should we keep it?")

    async def test_no_limit_means_the_council_runs_to_its_verdict_however_much_it_costs(self):
        self.cost = 50.0
        room, data = await self.convene(None)
        self.assertEqual(data["outcome"], "verdict")
        self.assertFalse(any("spend limit" in t.lower() for _, t in room.said), "off means silent")

    async def test_the_limit_is_announced_before_any_money_is_spent(self):
        room, _ = await self.convene(100.0)
        self.assertEqual(room.said[0], ("war-room", "Spend limit for this run: $100.00, checked between stages."))

    async def test_over_the_limit_after_planning_stops_before_anyone_investigates(self):
        room, data = await self.convene(0.5)  # the plan alone costs 0.60
        self.assertIsNone(data, "a handled stop returns nothing and raises nothing")
        self.assertEqual(self.asked, ["main"], "only the chair planned; nobody investigated")
        (row,) = self.ledger()
        self.assertEqual(row["outcome"], "over_budget")
        self.assertEqual(row["total_cost_usd"], 0.6)
        self.assertIn("spend limit", row["failure_summary"])
        self.assertIn("before the specialists investigate", row["failure_summary"])
        self.assertFalse(council.VERDICT_JSON.exists(), "a stopped run must not overwrite the last verdict")
        self.assertEqual(room.final()[0]["state"], "attention", "the meter is left in an honest final state")
        self.assertTrue(any("Stopped at the spend limit" in t for _, t in room.said))

    async def test_over_the_limit_after_investigating_stops_before_the_debate(self):
        _, data = await self.convene(1.5)  # plan 0.6 + two takes 1.2 = 1.8
        self.assertIsNone(data)
        self.assertEqual(sorted(self.asked), ["main", "ops", "research"], "no cross-examination, no verdict")
        (row,) = self.ledger()
        self.assertEqual((row["outcome"], row["total_cost_usd"]), ("over_budget", 1.8))
        self.assertIn("before the debate", row["failure_summary"])

    async def test_the_verdict_is_never_skipped_even_when_the_limit_is_crossed_during_the_debate(self):
        _, data = await self.convene(2.5)  # 1.8 after the takes (under), 3.0 after the debate (over): still gets its verdict
        self.assertEqual(data["outcome"], "verdict")
        self.assertTrue(council.VERDICT_JSON.exists())

    async def test_a_limit_nobody_reaches_changes_nothing(self):
        _, data = await self.convene(1000.0)
        self.assertEqual(data["outcome"], "verdict")
        self.assertEqual(self.ledger()[0]["outcome"], "verdict")

    async def test_an_unusable_setting_is_reported_and_means_no_limit(self):
        council.COST_LIMIT_RAW = "2usd"
        room = Room()
        data = await council.Council(room).deliberate("q")
        self.assertEqual(data["outcome"], "verdict", "a typo must not stop or change the run")
        self.assertTrue(any("NO spend limit" in t and "2usd" in t for _, t in room.said))


class BuildLimitTests(Base):
    def setUp(self):
        super().setUp()
        self.edit_files = None  # None: each owner changes docs/<owner>.md
        council.VERDICT_JSON.write_text(json.dumps({
            "run": "abcd1234", "question": "q", "verdict": "do it", "success_metrics": ["works"],
            "plan": [{"owner": "ops", "step": "change docs", "done_when": "changed"},
                     {"owner": "comms", "step": "tell people", "done_when": "told"}]}), encoding="utf-8")

        async def ask(agent, prompt, *, schema=None, on_event=None, **kw):
            self.asked.append(agent)
            if schema is council.REVIEW:
                return {"ok": True, "provider": "claude", "hasTools": True, "costUsd": self.cost, "data": {
                    "approved": True, "issues": [], "spoken": "r", "criteria": [{"criterion": "works", "met": True, "how": "read"}]}}
            return {"ok": True, "provider": "claude", "hasTools": True, "costUsd": self.cost, "data": {
                "changed_files": [f"docs/{agent}.md"] if self.edit_files is None else self.edit_files, "blocked": [], "spoken": "done", "done": [{"step": "s", "result": "ok"}]}}

        council.ab.ask = ask

    async def build(self, limit):
        room = Room()
        c = council.Council(room)
        c.cost_limit = limit
        return room, await c.execute()

    async def test_a_build_stops_between_owners_keeps_its_files_and_offers_fix(self):
        room, data = await self.build(0.5)  # ops costs 0.60, so comms never starts
        self.assertIsNone(data)
        self.assertEqual(self.asked, ["ops"], "the second owner never started, and no review was paid for")
        (row,) = self.ledger()
        self.assertEqual((row["outcome"], row["kind"], row["changed_files"], row["interrupted_at"]),
                         ("over_budget", "build", ["docs/ops.md"], "execute"))
        self.assertIn("stopped at the spend limit during execute: 1 file already changed", row["headline"])
        self.assertIn("before comms starts", row["failure_summary"])
        (card,) = room.cards()
        self.assertEqual((card["state"], card["files"], [a["id"] for a in card["actions"]]), ("attention", ["docs/ops.md"], ["fix"]))
        state = json.loads(council.BUILD_STATE_JSON.read_text())
        self.assertEqual((state["outcome"], state["missing"], state["actions"]), ("over_budget", ["comms"], ["fix"]))
        self.assertEqual(room.final()[0]["state"], "attention")

    async def test_a_build_stopped_before_any_file_changed_is_recorded_but_saves_no_state(self):
        self.edit_files = []  # the first owner spent money and changed nothing
        room, _ = await self.build(0.5)
        (row,) = self.ledger()
        self.assertEqual((row["outcome"], row["changed_files"]), ("over_budget", []))
        self.assertIn("nothing was changed", row["headline"])
        self.assertEqual(room.cards(), [], "no Fix button when there is nothing to fix: just build again")
        self.assertFalse(council.BUILD_STATE_JSON.exists(), "and an earlier build's state is not overwritten")

    async def test_a_limit_nobody_reaches_lets_the_build_finish_and_be_reviewed(self):
        _, data = await self.build(100.0)
        self.assertEqual(data["outcome"], "built")
        self.assertEqual(self.asked, ["ops", "comms", "research"], "both owners, then the review")

    async def test_the_build_announces_its_limit(self):
        room, _ = await self.build(100.0)
        self.assertIn(("war-room", "Spend limit for this run: $100.00, checked between stages."), room.said)


if __name__ == "__main__":
    unittest.main()
