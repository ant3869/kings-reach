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
        self.saved = {k: getattr(council, k) for k in ("VERDICT_JSON", "RUNS_FILE", "COUNCIL_DIR", "BUILD_STATE_JSON")}
        council.VERDICT_JSON, council.RUNS_FILE, council.COUNCIL_DIR = verdict, tmp / "runs.jsonl", tmp / "council"
        council.BUILD_STATE_JSON = tmp / "build-state.json"  # a build must never touch the real latest-build state
        self.saved_ab = (council.ab.ask, council.ab.record)
        self.saved_build = (council.build.preflight, council.build.gate)
        self.asked = []
        self.preflight_ok, self.gate_ok, self.approve, self.explode = True, True, True, None
        self.edits = ["docs/x.md"]  # what the executor reports it changed (empty = Codex with a broken sandbox)
        self.prompts = []
        self.fixer_fails = self.ops_fails = self.cancel_review = self.cancel_after_edit = False

        async def ask(agent, prompt, *, schema=None, on_event=None, **kw):
            self.asked.append(agent)
            self.prompts.append((agent, prompt))
            if self.explode:
                raise self.explode
            if (agent == "main" and self.fixer_fails) or (agent == "ops" and self.ops_fails):
                return {"ok": False, "text": "no structured answer", "provider": "claude"}
            if schema is council.REVIEW:
                if self.cancel_review:
                    raise asyncio.CancelledError()
                return {"ok": True, "provider": "claude", "hasTools": True, "data": {
                    "approved": self.approve, "issues": [] if self.approve else ["nope"], "spoken": "reviewed",
                    "criteria": [{"criterion": "works", "met": self.approve, "how": "read it"}]}}
            if on_event:
                await on_event({"kind": "turn", "turn": 1, "maxTurns": 40})
                await on_event({"kind": "tool", "tool": "Edit", "text": "Editing docs/x.md", "target": "docs/x.md", "edit": True})
            if self.cancel_after_edit and agent == "ops":
                raise asyncio.CancelledError()  # the tab's Cancel arrives after the file was edited, before the report
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

    async def test_review_rejection_is_not_a_success_but_it_is_not_a_failure_either(self):
        # Green checks and a reviewer who is not satisfied: the files are on disk and safe, so it needs a DECISION. Showing
        # that as the same red FAILED as a broken baseline told the user nothing about their files or what to do.
        self.approve = False
        room, data = await self.run_build()
        final = room.final()[0]
        self.assertEqual((final["state"], final["failed"]), ("attention", False))
        self.assertIn("not satisfied", final["note"])
        self.assertEqual(room.progress("complete"), ["attention"])
        self.assertEqual(room.progress("review")[-1], "attention")
        self.assertFalse(data["approved"])
        self.assertEqual(data["outcome"], "needs_work", "the ledger still records that it was not approved")

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

    def ledger(self):
        return [json.loads(x) for x in council.RUNS_FILE.read_text(encoding="utf-8").splitlines()]

    async def test_a_build_cancelled_after_an_edit_is_recorded_with_the_file_it_touched(self):
        """The real incident: Ops had edited a file, the page reloaded, and the Build left no row and no state at all."""
        self.cancel_after_edit = True
        room, data = await self.run_build()
        self.assertIsNone(data)
        (row,) = self.ledger()
        self.assertEqual((row["kind"], row["outcome"], row["interrupted_at"]), ("build", "cancelled", "execute"))
        self.assertEqual(row["changed_files"], ["docs/x.md"], "seen in the live feed even though Ops never reported it")
        self.assertFalse(row["approved"] or row["checks_ok"])
        self.assertIn("Cancelled during execute", row["failure_summary"])
        self.assertIn("1 file already changed", row["headline"])
        self.assertEqual(room.final()[0]["state"], "cancelled")
        self.assertEqual(room.metrics()[-1]["outcome"], "cancelled")

    async def test_such_a_build_can_be_continued_with_fix_and_says_what_is_unfinished(self):
        import buildflow
        self.cancel_after_edit = True
        room, _ = await self.run_build()
        (card,) = room.cards()
        self.assertEqual((card["state"], [a["id"] for a in card["actions"]], card["files"]), ("attention", ["fix"], ["docs/x.md"]))
        self.assertTrue(any("ops never reported: change docs" in i for i in card["issues"]), card["issues"])
        saved = buildflow.load_build_state(council.BUILD_STATE_JSON)
        self.assertEqual((saved["outcome"], saved["missing"], saved["actions"], saved["checks_ok"]), ("cancelled", ["ops"], ["fix"], False))
        self.assertEqual(buildflow.resumable_card(council.VERDICT_JSON, council.BUILD_STATE_JSON), card, "a page that reconnects gets the Fix button back")
        self.cancel_after_edit = False
        room2, data = await self.run_followup("fix")
        self.assertEqual(data["outcome"], "built", "Fix finished it and the checks and review ran")
        main_prompt = next(p for a, p in self.prompts if a == "main")
        self.assertIn("ops never reported: change docs", main_prompt, "Main is told exactly what was left")
        self.assertIn("docs/x.md", main_prompt)

    async def test_a_build_cancelled_before_anything_was_edited_is_recorded_but_saves_no_state(self):
        self.explode = asyncio.CancelledError()  # the first agent call is cancelled: nothing was edited
        room, _ = await self.run_build()
        (row,) = self.ledger()
        self.assertEqual((row["outcome"], row["changed_files"], row["interrupted_at"]), ("cancelled", [], "execute"))
        self.assertIn("nothing was changed", row["headline"])
        self.assertEqual(room.cards(), [], "no Fix button for a build that changed nothing: just build again")
        self.assertFalse(council.BUILD_STATE_JSON.exists(), "and an earlier build's state is not overwritten")

    async def test_a_crash_is_recorded_too_and_still_raised(self):
        self.explode = RuntimeError("provider exploded")
        with self.assertRaises(RuntimeError):
            await council.Council(Room()).execute()
        (row,) = self.ledger()
        self.assertEqual(row["outcome"], "crashed")
        self.assertIn("provider exploded", row["failure_summary"])

    async def test_a_finished_build_is_recorded_once_not_again_when_it_is_cancelled_late(self):
        self.cancel_review = True  # cancelled while Research reviews: the run has not concluded yet
        await self.run_build()
        self.assertEqual([r["outcome"] for r in self.ledger()], ["cancelled"])
        self.cancel_review = False
        await self.run_build()
        self.assertEqual([r["outcome"] for r in self.ledger()], ["cancelled", "built"], "one row per run, whatever happened to it")

    async def test_a_run_that_had_already_concluded_is_not_recorded_a_second_time(self):
        class CancelAtTheCard(Room):
            async def send(self, obj):
                if obj.get("type") == "build_result":
                    raise asyncio.CancelledError()  # cancelled while the result card is being shown: the ledger row is already written
                await super().send(obj)

        try:
            await council.Council(CancelAtTheCard()).execute()
        except asyncio.CancelledError:
            pass
        self.assertEqual([r["outcome"] for r in self.ledger()], ["built"], "one row, with the real outcome")

    async def test_failing_to_write_the_note_neither_hides_the_cancel_nor_leaves_the_meter_busy(self):
        async def broken(self, outcome, detail=""):
            raise OSError("disk full")

        saved = council.Council.record_interruption
        council.Council.record_interruption = broken
        try:
            self.cancel_after_edit = True
            room, data = await self.run_build()  # run_build only swallows CancelledError: an OSError would fail this test
        finally:
            council.Council.record_interruption = saved
        self.assertIsNone(data)
        self.assertEqual(room.final()[0]["state"], "cancelled", "the page still learns the run ended")
        self.assertTrue(any("Could not write down the stopped run: disk full" in t for _, t in room.said))

    async def test_ledger_went_to_the_temp_dir(self):
        await self.run_build()
        self.assertTrue(council.RUNS_FILE.exists())
        self.assertNotEqual(council.RUNS_FILE.parent.name, "store")

    # --- what the user is told ------------------------------------------------------------------------------------
    async def test_a_rejected_build_says_what_happened_and_offers_the_three_ways_forward(self):
        self.approve = False
        room, _ = await self.run_build()
        card = room.cards()[0]
        self.assertEqual((card["state"], card["headline"]), ("attention", "Built, but Research is not satisfied"))
        self.assertIn("kept exactly as written", card["detail"])  # the first thing the user wonders: are my files still changed?
        self.assertEqual(card["files"], ["docs/x.md"])
        self.assertEqual([a["id"] for a in card["actions"]], ["review", "fix", "accept"])
        self.assertTrue(all(a["label"] and a["hint"] for a in card["actions"]))
        self.assertEqual(card["issues"], ["nope", "Not confirmed: works (read it)"])  # the reviewer's own words, not a bare 'issues'

    async def test_failed_checks_can_only_be_fixed_not_rechecked_or_accepted(self):
        self.gate_ok = False
        room, _ = await self.run_build()
        card = room.cards()[0]
        self.assertEqual((card["state"], card["headline"]), ("failed", "The automated checks failed"))
        self.assertEqual([a["id"] for a in card["actions"]], ["fix"])
        self.assertEqual(card["output"], "gate output")

    async def test_success_empty_and_broken_baseline_have_their_own_plain_cards(self):
        room, _ = await self.run_build()
        self.assertEqual((room.cards()[0]["state"], room.cards()[0]["actions"]), ("complete", []))
        self.edits = []
        room, _ = await self.run_build()
        self.assertEqual((room.cards()[0]["headline"], room.cards()[0]["actions"]), ("Nothing was built", []),
                         "nothing changed, so there is nothing to continue: building again is the right move")
        self.preflight_ok, self.asked = False, []
        room, _ = await self.run_build()
        card = room.cards()[0]
        self.assertEqual((card["headline"], card["files"], card["actions"]), ("Stopped before anything was edited", [], []))
        self.assertEqual((card["output"], self.asked), ("baseline output", []))

    # --- carrying on without redoing it ---------------------------------------------------------------------------
    async def run_followup(self, action):
        room, data = Room(), None
        try:
            data = await council.Council(room).followup(action)
        except asyncio.CancelledError:
            pass
        return room, data

    async def rejected_build(self):
        self.approve = False
        await self.run_build()
        self.approve, self.asked, self.prompts = True, [], []

    async def test_the_latest_build_is_remembered_and_a_reconnecting_page_gets_its_buttons_back(self):
        import buildflow
        self.approve = False
        room, _ = await self.run_build()
        card = buildflow.resumable_card(council.VERDICT_JSON, council.BUILD_STATE_JSON)
        self.assertEqual(card, room.cards()[0])
        council.VERDICT_JSON.write_text(json.dumps({"run": "ffff0000", "plan": []}), encoding="utf-8")
        self.assertIsNone(buildflow.resumable_card(council.VERDICT_JSON, council.BUILD_STATE_JSON),
                          "a newer verdict makes the old build's buttons meaningless")

    async def test_recheck_asks_only_the_reviewer_and_runs_no_edit_step(self):
        await self.rejected_build()
        room, data = await self.run_followup("review")
        self.assertEqual(self.asked, ["research"], "nobody re-implements anything")
        self.assertEqual([n for n, s in room.stages if s == "active"], ["gate", "review"], "no preflight, no execute")
        self.assertEqual((data["outcome"], data["followup"], room.final()[0]["state"]), ("built", "review", "complete"))
        self.assertEqual((room.cards()[0]["state"], room.cards()[0]["actions"]), ("complete", []))
        self.assertEqual(len(council.RUNS_FILE.read_text(encoding="utf-8").splitlines()), 2, "its cost is its own ledger line")

    async def test_fix_sends_main_only_what_is_still_wrong_then_rechecks_and_reviews(self):
        await self.rejected_build()
        self.edits = ["docs/y.md"]
        room, data = await self.run_followup("fix")
        self.assertEqual(self.asked, ["main", "research"], "one fixer, then the review: ops is not asked to redo its work")
        prompt = self.prompts[0][1]
        self.assertIn("do NOT redo it", prompt)
        self.assertIn("- nope", prompt)
        self.assertIn("- Not confirmed: works (read it)", prompt)
        self.assertIn("- docs/x.md", prompt, "it is told which files are already changed")
        self.assertEqual(data["outcome"], "built")
        self.assertEqual(sorted(data["changed_files"]), ["docs/x.md", "docs/y.md"], "the earlier files are not forgotten")
        self.assertEqual([n for n, s in room.stages if s == "active"], ["execute", "gate", "review"])

    async def test_a_fix_that_reports_nothing_is_not_re_reviewed_and_the_buttons_stay(self):
        await self.rejected_build()
        self.fixer_fails = True
        room, data = await self.run_followup("fix")
        self.assertEqual(self.asked, ["main"], "no reviewer is paid for when nothing changed")
        card = room.cards()[0]
        self.assertEqual(card["state"], "attention")
        self.assertEqual(card["issues"][0], "The fix attempt returned no usable report, so nothing was changed.")
        self.assertEqual([a["id"] for a in card["actions"]], ["review", "fix", "accept"], "try again, or choose differently")

    async def test_keep_as_is_costs_nothing_and_says_it_was_your_decision(self):
        await self.rejected_build()
        room, data = await self.run_followup("accept")
        self.assertEqual(self.asked, [], "accepting asks nobody")
        self.assertEqual((data["outcome"], data["review_status"], data["total_cost_usd"]), ("built", "accepted by you", 0))
        card = room.cards()[0]
        self.assertEqual((card["state"], card["headline"], card["actions"], card["issues"]), ("complete", "Kept as you decided", [], []))

    async def test_failing_code_cannot_be_kept_and_nothing_runs_for_an_unavailable_option(self):
        self.gate_ok = False
        await self.run_build()
        self.asked = []
        room, data = await self.run_followup("accept")
        self.assertIsNone(data)
        self.assertEqual(self.asked, [])
        self.assertTrue(any("not available" in text for _, text in room.said))
        self.assertEqual(room.final(), [], "nothing started, so there is no run to finish")

    async def test_no_build_or_a_newer_verdict_means_there_is_nothing_to_continue(self):
        room, data = await self.run_followup("review")
        self.assertIsNone(data)
        self.assertTrue(any("no build to continue" in text for _, text in room.said))
        await self.rejected_build()
        council.VERDICT_JSON.write_text(json.dumps({"run": "ffff0000", "plan": []}), encoding="utf-8")
        room, data = await self.run_followup("fix")
        self.assertIsNone(data)
        self.assertTrue(any("older verdict" in text for _, text in room.said))
        self.assertEqual(self.asked, [])

    async def test_an_owner_that_never_reported_is_named_and_the_fix_takes_over_its_steps(self):
        self.ops_fails = True
        room, data = await self.run_build()
        card = room.cards()[0]
        self.assertEqual(data["execution_failures"], ["ops"])
        self.assertEqual((card["state"], [a["id"] for a in card["actions"]]), ("failed", ["fix"]))
        self.assertEqual(card["headline"], "An owner did not finish", "never '0 files changed and are kept on disk'")
        self.assertIn("ops never reported back, so these steps may be unfinished: change docs", card["issues"])
        self.ops_fails, self.asked, self.prompts = False, [], []
        self.edits = ["docs/x.md"]
        room, data = await self.run_followup("fix")
        self.assertIn("change docs", self.prompts[0][1], "the fixer is told which steps nobody finished")
        self.assertEqual((data["outcome"], data["execution_failures"]), ("built", []))

    async def test_files_a_fix_changed_are_remembered_even_if_it_is_cancelled_before_it_finishes(self):
        await self.rejected_build()
        self.edits, self.cancel_review = ["docs/y.md"], True
        room, data = await self.run_followup("fix")
        self.assertIsNone(data)
        self.assertEqual(room.final()[0]["state"], "cancelled")
        import buildflow
        saved = buildflow.load_build_state(council.BUILD_STATE_JSON)
        self.assertEqual(sorted(saved["changed"]), ["docs/x.md", "docs/y.md"])


class BuildMessageTests(unittest.TestCase):
    """The pure rules for what the user is told about a build."""

    def test_state_separates_work_that_needs_a_decision_from_work_that_broke(self):
        from ledger import build_state
        self.assertEqual(build_state("built", True), "complete")
        self.assertEqual(build_state("needs_work", True), "attention", "green checks, unconvinced reviewer")
        for outcome, checks in (("needs_work", False), ("no_changes", True), ("preflight_failed", False)):
            self.assertEqual(build_state(outcome, checks), "failed", outcome)

    def test_only_a_build_with_something_left_to_continue_offers_follow_ups(self):
        from ledger import build_followups
        self.assertEqual(build_followups("needs_work", True, ["a"]), ["review", "fix", "accept"])
        self.assertEqual(build_followups("needs_work", False, ["a"]), ["fix"], "never keep or re-check failing code")
        self.assertEqual(build_followups("needs_work", False, [], unfinished=True), ["fix"], "an owner that never reported")
        for case in (("built", True, ["a"]), ("no_changes", True, []), ("preflight_failed", False, []), ("needs_work", False, [])):
            self.assertEqual(build_followups(*case), [], case)

    def test_headlines_answer_what_happened_to_the_files(self):
        from ledger import build_headline
        self.assertEqual(build_headline("built", True, ["a", "b"])[1], "2 files changed. The automated checks passed and Research approved the work.")
        self.assertEqual(build_headline("built", True, ["a"], accepted=True)[0], "Kept as you decided")
        head, detail = build_headline("needs_work", True, ["a"], tally="1/8")
        self.assertEqual(head, "Built, but Research is not satisfied")
        for must_say in ("1 file changed", "kept exactly as written", "nothing has been restarted", "1/8"):
            self.assertIn(must_say, detail)
        self.assertIn("did not pass the checks", build_headline("needs_work", False, ["a"])[1])
        self.assertIn("no agent ran and no file changed", build_headline("preflight_failed", False, [])[1])

    def test_issues_list_what_is_still_wrong_in_the_reviewers_words(self):
        from ledger import build_issues
        review = {"issues": ["log is too low"], "criteria": [{"criterion": "A", "met": True, "how": "read"},
                                                             {"criterion": "B", "met": False, "how": "not measured"}]}
        self.assertEqual(build_issues(review, {"ops": "x; y"}, ["extra"]), [
            "extra", "ops never reported back, so these steps may be unfinished: x; y", "log is too low", "Not confirmed: B (not measured)"])
        self.assertEqual(build_issues(None, {}), [])

    def test_state_file_round_trip_and_garbage_is_ignored(self):
        from ledger import load_build_state, save_build_state
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sub" / "state.json"
            self.assertIsNone(load_build_state(path))
            save_build_state(path, {"a": [1, 2]})
            self.assertEqual(load_build_state(path), {"a": [1, 2]})
            path.write_text("not json", encoding="utf-8")
            self.assertIsNone(load_build_state(path))
            path.write_text("[1]", encoding="utf-8")
            self.assertIsNone(load_build_state(path), "a list is not a state")


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
