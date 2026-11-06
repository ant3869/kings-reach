"""Council.execute() event order and failure handling, with every agent and check stubbed (no cost, no real files).

The ledger and verdict paths are redirected to a temp dir: this must never touch store/ or the real run history.
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


class ExecuteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        verdict = tmp / "verdict.json"
        verdict.write_text(json.dumps({
            "run": "abcd1234", "question": "q", "verdict": "do it", "success_metrics": ["works"],
            "plan": [{"owner": "ops", "step": "change docs", "done_when": "file changed"}]}), encoding="utf-8")
        self.saved = {k: getattr(council, k) for k in ("VERDICT_JSON", "RUNS_FILE", "COUNCIL_DIR")}
        council.VERDICT_JSON, council.RUNS_FILE, council.COUNCIL_DIR = verdict, tmp / "runs.jsonl", tmp / "council"
        self.saved_ab = (council.ab.ask, council.ab.record)
        self.saved_build = (council.build.preflight, council.build.gate)
        self.asked = []
        self.preflight_ok, self.gate_ok, self.approve, self.explode = True, True, True, None
        self.edits = ["docs/x.md"]  # what the executor reports it changed (empty = Codex with a broken sandbox)

        async def ask(agent, prompt, *, schema=None, on_event=None, **kw):
            self.asked.append(agent)
            if self.explode:
                raise self.explode
            if schema is council.REVIEW:
                return {"ok": True, "provider": "claude", "hasTools": True, "data": {
                    "approved": self.approve, "issues": [] if self.approve else ["nope"], "spoken": "reviewed",
                    "criteria": [{"criterion": "works", "met": self.approve, "how": "read it"}]}}
            if on_event:
                await on_event({"kind": "turn", "turn": 1, "maxTurns": 40})
                await on_event({"kind": "tool", "tool": "Edit", "text": "Editing docs/x.md", "target": "docs/x.md", "edit": True})
            return {"ok": True, "provider": "claude", "hasTools": True, "data": {
                "changed_files": self.edits, "blocked": [], "spoken": "done",
                "done": [{"step": "change docs", "result": "changed"}]}}

        async def record(**kw):
            return {"memories": 0, "hive": 0}

        council.ab.ask, council.ab.record = ask, record
        council.build.preflight = lambda py: {"ok": self.preflight_ok, "output": "baseline output"}
        council.build.gate = lambda files, py: {"ok": self.gate_ok, "output": "gate output"}

    def tearDown(self):
        for key, value in self.saved.items():
            setattr(council, key, value)
        council.ab.ask, council.ab.record = self.saved_ab
        council.build.preflight, council.build.gate = self.saved_build
        self.tmp.cleanup()

    async def run_build(self):
        room = Room()
        data = None
        try:
            data = await council.Council(room).execute()
        except asyncio.CancelledError:
            pass
        return room, data

    async def test_successful_build_leaves_no_phase_unresolved(self):
        room, data = await self.run_build()
        self.assertEqual(data["outcome"], "built")
        for phase in ("preflight", "execute", "gate", "review"):
            self.assertEqual(room.progress(phase)[-1], "done", f"{phase}: {room.progress(phase)}")
        self.assertEqual(room.progress("complete"), ["done"])
        order = [n for n, s in room.stages if s == "active"]
        self.assertEqual(order, ["preflight", "execute", "gate", "review"])
        final = room.final()
        self.assertEqual((len(final), final[0]["state"], final[0]["pct"]), (1, "complete", 100))
        self.assertTrue(any("complete" in t.lower() for t in room.spoken))

    async def test_progress_never_reaches_100_before_the_end(self):
        room, _ = await self.run_build()
        meters = [m["pct"] for m in room.sent if m.get("type") == "meter" and not m.get("final")]
        self.assertTrue(meters and max(meters) < 100)
        self.assertEqual(meters, sorted(meters), "the bar must not run backwards")

    async def test_edit_is_always_visible_but_routine_commentary_respects_the_quiet_gap(self):
        room, _ = await self.run_build()
        edits = [m for m in room.sent if m.get("type") == "activity" and m.get("edit")]
        self.assertEqual([e["target"] for e in edits], ["docs/x.md"])  # the page always sees it
        # ...but a stage announcement spoke milliseconds earlier, so a routine remark must not talk over it.
        self.assertEqual(sum("First change" in t for t in room.spoken), 0)
        self.assertEqual(len(room.spoken), len(set(room.spoken)), "no line is spoken twice")

    async def test_failed_gate_marks_the_chip_failed_and_skips_review(self):
        self.gate_ok = False
        room, data = await self.run_build()
        self.assertEqual(data["outcome"], "needs_work")
        self.assertEqual(room.stages[[i for i, s in enumerate(room.stages) if s[0] == "gate"][-1]][1], "failed",
                         "a failed check must not leave a success-coloured chip")
        self.assertEqual(room.progress("gate")[-1], "failed")
        self.assertEqual(room.progress("review"), ["skipped"])
        self.assertEqual(self.asked.count("research"), 0, "no reviewer is paid for after a failed gate")
        final = room.final()
        self.assertEqual((final[0]["state"], final[0]["failed"]), ("failed", True))
        self.assertLess(final[0]["pct"], 100)

    async def test_a_build_that_changed_nothing_skips_the_review_and_is_no_changes(self):
        self.edits = []
        room, data = await self.run_build()
        self.assertEqual(data["outcome"], "no_changes")
        self.assertEqual(self.asked.count("research"), 0, "nobody is paid to approve an empty build")
        self.assertEqual(room.progress("review"), ["skipped"])
        self.assertFalse(data["approved"])
        self.assertIn("no review was run", data["failure_summary"])
        final = room.final()
        self.assertEqual((final[0]["state"], final[0]["failed"]), ("failed", True), "an empty build is never a success")
        self.assertLess(final[0]["pct"], 100)

    async def test_review_rejection_is_a_failed_run_not_a_success(self):
        self.approve = False
        room, data = await self.run_build()
        self.assertEqual(room.final()[0]["state"], "failed")
        self.assertEqual(room.progress("complete"), ["failed"])
        self.assertFalse(data["approved"])

    async def test_broken_baseline_stops_before_any_agent_runs(self):
        self.preflight_ok = False
        room, data = await self.run_build()
        self.assertEqual(data["outcome"], "preflight_failed")
        self.assertEqual(self.asked, [])
        self.assertEqual(room.progress("preflight")[-1], "failed")
        self.assertEqual(room.final()[0]["state"], "failed")

    async def test_cancel_is_reported_as_cancelled_not_failed(self):
        self.explode = asyncio.CancelledError()
        room, data = await self.run_build()
        self.assertIsNone(data)
        final = room.final()
        self.assertEqual((final[0]["state"], final[0]["failed"]), ("cancelled", False))

    async def test_ledger_went_to_the_temp_dir(self):
        await self.run_build()
        self.assertTrue(council.RUNS_FILE.exists())
        self.assertNotEqual(council.RUNS_FILE.parent.name, "store")


class BuildOutcomeTests(unittest.TestCase):
    def test_outcome_table(self):
        from ledger import build_outcome
        self.assertEqual(build_outcome(True, True, ["a.py"]), "built")
        self.assertEqual(build_outcome(True, False, ["a.py"]), "needs_work")
        self.assertEqual(build_outcome(False, True, ["a.py"]), "needs_work")
        self.assertEqual(build_outcome(True, True, []), "no_changes")
        self.assertEqual(build_outcome(True, False, []), "no_changes", "no review happens when nothing changed")
        self.assertEqual(build_outcome(False, False, []), "needs_work", "a failed gate is still a failure")


if __name__ == "__main__":
    unittest.main()
