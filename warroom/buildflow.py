"""Build, second half: check, review, conclude, and the follow-ups that continue a build WITHOUT redoing it.

A Build used to be all or nothing. When the reviewer was not satisfied the only way forward was to press Build again, which
ran the whole plan from the start on top of files it had already edited. Now what a build leaves behind is saved
(store/build-state.json) and the user can re-check, fix just what was flagged, or keep the files as they are.

BuildFlow is a mixin for Council and uses its room, live, state_file, _ask, _stage and _progress.
"""

import asyncio
import json
import sys

try:
    from . import agent_bridge as ab
    from . import build
    from . import interrupted
    from .ledger import (FOLLOWUPS, build_followups, build_headline, build_issues, build_outcome, build_state,
                         criteria_tally, load_build_state, save_build_state)
    from .schemas import EXECUTE, READ_ONLY_NOTE, REVIEW, TOOLS_NOTE, TURNS, bullets
except ImportError:  # run as a script
    import agent_bridge as ab
    import build
    import interrupted
    from ledger import (FOLLOWUPS, build_followups, build_headline, build_issues, build_outcome, build_state,
                        criteria_tally, load_build_state, save_build_state)
    from schemas import EXECUTE, READ_ONLY_NOTE, REVIEW, TOOLS_NOTE, TURNS, bullets


def steps_of(verdict, owner):
    return "; ".join(s["step"] for s in verdict.get("plan", []) if s["owner"] == owner)


def continuation(verdict_path, state_path):
    """(verdict, state, problem). `problem` is a sentence for the user when the latest build cannot be continued: a build
    can only be continued against the verdict it was built from (a newer council overwrites it)."""
    state = load_build_state(state_path)
    if not state:
        return None, None, "There is no build to continue. Build the verdict first."
    try:
        verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None, "The verdict on file could not be read, so that build cannot be continued."
    if verdict.get("run") != state.get("verdict_run"):
        return None, None, ("That build belongs to an older verdict (a newer council has been held since), so it cannot be "
                            "continued. Build the current verdict instead.")
    return verdict, state, ""


def resumable_card(verdict_path, state_path):
    """The saved result card, if the latest build can still be continued: a page that reconnects gets its buttons back."""
    _, state, problem = continuation(verdict_path, state_path)
    return state["result"] if not problem and state.get("actions") else None


class BuildFlow:
    async def record_interruption(self, outcome, detail=""):
        """A run was stopped (Cancel, or an error) before it concluded: write that down instead of leaving no trace.

        The ledger always gets a row. A Build that had already edited files also saves its state and offers Fix, because
        those edits are on disk and nobody has checked them."""
        run = self.run
        if run is None or "outcome" in run.data:  # nothing started, or it had already been recorded
            return
        stage, part = run.open_stage(), self.partial
        observed = [f for t in self.live.trackers.values() for f in t.edited]
        changed = interrupted.merge_files(part["changed"] if part else [], observed)
        data = run.finish(**interrupted.ledger_fields(run.data["kind"], outcome, stage, changed, detail))
        if part and changed:
            owners, reports, v = part["owners"], part["reports"], part["v"]
            issue_list = interrupted.issues(owners, reports, lambda o: steps_of(v, o), changed)
            headline = data["headline"]
            card = await self.show_result("attention", headline, "Your edits are kept. Fix finishes what was left and then checks it, "
                                          "or you can build again.", issues=issue_list, files=changed, actions=["fix"])
            save_build_state(self.state_file, interrupted.build_state(v.get("run"), outcome, changed, reports, owners, issue_list, card))
        await self.room.send({"type": "metrics", **data})

    async def show_result(self, state, headline, detail, *, issues=(), files=(), output="", actions=()):
        """The one card that answers 'what happened, are my files still changed, and what can I do now?'"""
        card = {"type": "build_result", "state": state, "headline": headline, "detail": detail, "issues": list(issues),
                "files": list(files), "output": output[:2000], "actions": [{"id": a, **FOLLOWUPS[a]} for a in actions]}
        await self.room.send(card)
        return card

    async def _check_and_review(self, run, v, ctx):
        """The automated gate, then Research's review. Shared by the first build and every follow-up that changes files."""
        changed, reports = ctx["changed"], ctx["reports"]
        await self.room.send({"type": "build_progress", "phase": "gate", "state": "active",
                              "elapsed": 0, "message": "Running automated checks"})
        await self.live.announce("main", f"Implementation is in: {len(changed)} file{'s' if len(changed) != 1 else ''} "
                                 "changed. Running the automated checks now.")
        gate = await self._stage(run, "gate", asyncio.to_thread(build.gate, changed, sys.executable))
        if ctx["missing"]:
            gate = {"ok": False, "output": gate["output"] + "; missing reports: " + ", ".join(ctx["missing"])}
        await self.room.send({"type": "build_progress", "phase": "gate",
                              "state": "done" if gate["ok"] else "failed", "elapsed": 0,
                              "message": "Automated checks passed" if gate["ok"] else "Automated checks failed",
                              "detail": gate["output"][:2000]})
        if not gate["ok"]:  # _stage marks a stage done when its coroutine returns; a failed check is returned, not raised
            await self.room.stage("gate", "failed", "checks failed")
        await self.room.status(("checks passed: " if gate["ok"] else "checks FAILED: ") + gate["output"][:1500])
        reviewable = gate["ok"] and bool(changed)  # an empty build has nothing to review (and Research would still "approve" it)
        await self.live.announce("main", "Checks passed. Research is reviewing the changes." if reviewable else
                                 "Nothing was changed, so there is nothing to review." if gate["ok"] else
                                 "Checks failed. The changes stay on disk but are not activated, and review is skipped.")
        review = None
        if reviewable:
            success_metrics = v.get("success_metrics", [])
            review, _ = await self._stage(run, "review", self._progress("review",
                "Research is checking changed files against the verdict", self._ask(run, "research", (
                    f"Review the council's build.\n[Verdict]\n{v['verdict']}\n\n[Success metrics]\n"
                    f"{bullets(success_metrics)}\n\n[Reports]\n" + "\n".join(
                        f"- {o}: {json.dumps(r['done'])[:1200]}" for o, r in reports.items())
                    + f"\n\n[Changed files]\n{bullets(changed)}\n[Automated checks]\n{gate['output'][:1500]}\n\n"
                    f"Open the changed files and verify each success metric yourself. {READ_ONLY_NOTE}\n{TOOLS_NOTE}"),
                    REVIEW, read_only=True, tools="required", max_turns=TURNS["review"], stage="review")))
        else:
            why = "nothing changed" if gate["ok"] else "gate failed"
            await self.room.stage("review", "skipped", why)
            await self.room.send({"type": "build_progress", "phase": "review", "state": "skipped", "elapsed": 0,
                                  "message": "Review skipped: no file changed" if gate["ok"]
                                  else "Review skipped because automated checks failed"})
        if review:
            met = "\n".join(f"- {'PASS' if c['met'] else 'FAIL'} {c['criterion']}: {c['how']}" for c in review["criteria"])
            await self.room.send({"type": "build_progress", "phase": "review",
                                  "state": "done" if review["approved"] else "attention", "elapsed": 0,
                                  "message": "Research approved the build" if review["approved"] else "Research wants changes"})
            await self.room.say("research", f"**{'Approved' if review['approved'] else 'Not approved'}**\n\n{met}"
                                + (f"\n\n**Issues**\n{bullets(review['issues'])}" if review["issues"] else ""),
                                spoken=review["spoken"], kind="review")
        return gate, review

    async def _conclude(self, run, v, ctx, gate, review, *, accepted=False, followup=None, extra_issues=()):
        """Reboot if the work is approved and needs it, record the run, remember where it stopped, and tell the user plainly."""
        changed, reports, missing = ctx["changed"], ctx["reports"], ctx["missing"]
        approved = accepted or bool(review and review["approved"])
        rebooted = None
        if gate["ok"] and approved and any(f.replace("\\", "/").lstrip("./").startswith("src/") for f in changed):
            await self.room.status("core code changed and checks pass: rebooting core...")
            await self.live.enter("reboot", caption="restarting the core, then waiting for it to answer")
            await self.live.announce("ops", "Core code changed. Restarting it and waiting for it to come back.")
            rebooted = await asyncio.to_thread(build.reboot_core)
            await self.live.leave("reboot", ok=rebooted["ok"])
            await self.live.announce("ops", "The core is back up." if rebooted["ok"] else
                                     "The core restart failed. Check the log before trusting this build.")
            await self.room.status(("core rebooted: " if rebooted["ok"] else "reboot FAILED: ") + rebooted["detail"])
        if any(f.replace("\\", "/").lstrip("./").startswith("warroom/") for f in changed):
            await self.room.status("war room code changed: restart the war room to load it.")
        if not followup:  # a follow-up must not write the same owners' hive entries twice
            await ab.record(hive=[{"agent": o, "action": "council_build", "summary": r["spoken"][:600],
                                   "meta": {"run": v.get("run"), "files": r["changed_files"][:20]}} for o, r in reports.items()])
        criteria = review["criteria"] if review else []
        failure = ("" if gate["ok"] and approved else
                   ("Automated checks failed; changes remain on disk but were not activated." if not gate["ok"]
                    else "Research review did not approve the build."))
        outcome = build_outcome(gate["ok"], approved, changed)
        if outcome == "no_changes":
            failure = ("No file changed, so nothing was built and no review was run. The owner could not edit: "
                       "check that its first working route has tools (Claude or Codex) and that Codex's sandbox works.")
        headline, detail = build_headline(outcome, gate["ok"], changed, criteria_tally(criteria) if criteria else "", failure,
                                          accepted=accepted and not (review and review["approved"]))
        state = build_state(outcome, gate["ok"])
        issues = [] if approved else build_issues(review, {o: steps_of(v, o) for o in missing}, extra_issues)
        actions = build_followups(outcome, gate["ok"], changed, unfinished=bool(missing))
        status = ("accepted by you" if accepted and not (review and review["approved"]) else
                  "approved" if approved else "not approved" if review else "skipped")
        data = run.finish(outcome=outcome, verdict_run=v.get("run"), changed_files=changed, checks_ok=gate["ok"],
                          approved=approved, criteria_met=criteria_tally(criteria), metrics_total=len(v.get("success_metrics", [])),
                          rebooted=bool(rebooted and rebooted["ok"]), failure_summary=failure,
                          gate_output=gate["output"][:3000], review_status=status, execution_failures=missing,
                          headline=headline, **({"followup": followup} if followup else {}))
        await self.live.announce("main", "Build complete and approved." if outcome == "built" else
                                 "The build is in and the checks passed, but Research is not satisfied. Your files are kept. "
                                 "Choose what happens next." if state == "attention" else f"Build did not succeed. {failure}")
        await self.room.send({"type": "build_progress", "phase": "complete", "elapsed": 0, "message": headline,
                              "state": {"complete": "done", "attention": "attention", "failed": "failed"}[state], "files": changed})
        card = await self.show_result(state, headline, detail, issues=issues, files=changed,
                                      output="" if gate["ok"] else gate["output"], actions=actions)
        save_build_state(self.state_file, {"verdict_run": v.get("run"), "outcome": outcome, "changed": changed, "reports": reports,
                                           "missing": missing, "checks_ok": gate["ok"], "gate_output": gate["output"][:3000],
                                           "review": review, "issues": issues, "actions": actions, "result": card})
        await self.room.send({"type": "metrics", **data})
        return data

    async def _followup(self, run, action, v, state):
        """Carry on from where the last build stopped: re-check it, fix only what was flagged, or keep it as it is."""
        ctx = {"changed": list(state["changed"]), "reports": dict(state["reports"]), "missing": list(state["missing"])}
        gate, review, extra = {"ok": state["checks_ok"], "output": state["gate_output"]}, state["review"], ()
        if action == "fix":
            if await self._fix_flagged(run, v, state, ctx):
                gate, review = await self._check_and_review(run, v, ctx)
            else:
                extra = ("The fix attempt returned no usable report, so nothing was changed.",)
        elif action == "review":
            gate, review = await self._check_and_review(run, v, ctx)
        return await self._conclude(run, v, ctx, gate, review, accepted=action == "accept", followup=action, extra_issues=extra)

    async def _fix_flagged(self, run, v, state, ctx):
        """Main fixes only what is still wrong. Returns True when it reported back (and ctx now includes its files)."""
        run.begin("execute")
        await self.room.stage("execute", "active", "fixing what was flagged")
        await self.live.enter("execute", 1, "fixing only what was flagged")
        await self.live.announce("main", "I will fix only what was flagged. Nothing that already works is redone.")
        report, _ = await self._progress("execute", "Main is fixing the flagged issues", self._ask(run, "main", (
            f"The council decided:\n{v['verdict']}\n\n[Success metrics]\n{bullets(v.get('success_metrics', []))}\n\n"
            "A build of this plan was already carried out and its files are on disk, so do NOT redo it. It is not finished. "
            "Fix ONLY the problems below with minimal, surgical changes, then verify each one yourself.\n\n"
            f"[Still wrong]\n{bullets(state['issues'])}\n\n"
            + ("" if state["checks_ok"] else f"[Automated check output]\n{state['gate_output'][:1500]}\n\n")
            + f"[Files already changed]\n{bullets(ctx['changed'])}\n\n"
            "Keep files under 600 lines. Never restart servers, kill processes or touch store/. "
            f"Report every file you changed (repo-relative).\n{TOOLS_NOTE}"),
            EXECUTE, tools="required", max_turns=TURNS["execute"], stage="execute"))
        run.end("execute")
        await self.live.leave("execute", ok=bool(report))
        await self.room.stage("execute", "done" if report else "failed", "fix attempted" if report else "no report")
        await self.room.send({"type": "build_progress", "phase": "execute", "state": "done" if report else "failed", "elapsed": 0,
                              "message": f"fix finished; {len(report['changed_files'])} file(s) reported" if report
                              else "the fix attempt returned no usable report"})
        if not report:
            return False
        await self.room.say("main", "\n".join(f"- {d['step']}: {d['result']}" for d in report["done"])
                            + (f"\n\n**Blocked:** {'; '.join(report['blocked'])}" if report["blocked"] else ""),
                            spoken=report["spoken"], kind="build")
        ctx["changed"] = list(dict.fromkeys(ctx["changed"] + report["changed_files"]))
        ctx["reports"] = {**ctx["reports"], "main (fix)": report}
        ctx["missing"] = []  # Main was handed any steps an owner never reported
        # Remember the files NOW: if the run is cancelled before it concludes, they must not be forgotten.
        save_build_state(self.state_file, {**state, "changed": ctx["changed"], "reports": ctx["reports"], "missing": ctx["missing"]})
        return True
