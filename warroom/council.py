"""The council: recall -> plan -> investigate -> debate -> verdict -> record, then optional execute.

Every stage returns schema-validated JSON (SDK outputFormat). `spoken` fields are what the
voices say; everything else is evidence for the log, the verdict file and the scoreboard.
Deliberation is read-only (no Write/Edit tools); only execute() may change things.
`room` is the UI sink: stage(), say(), thinking(), status(), send(), narrate(). Live progress (what each agent is
doing, the overall meter, spoken commentary) comes from live.py, fed by the bridge's activity stream.
"""

import asyncio
import json
import sys
import time
import uuid

try:
    from . import agent_bridge as ab
    from . import build
    from . import mindchange
    from .config import (AGENT_BRIDGE_PATH, COUNCIL_DIR, DEBATE_ROUNDS, INVESTIGATE_TURNS, PROJECT_ROOT,
                         RUNS_FILE, VERDICT_ARCHIVE_DIR, VERDICT_FILE, VERDICT_JSON)
    from .ledger import archive_verdict, build_outcome, criteria_tally
    from .live import BUILD_PHASES, COUNCIL_PHASES, Live
    from .personas import AGENT_IDS, SPECIALISTS, persona_prompt
except ImportError:  # run as a script
    import agent_bridge as ab
    import build
    import mindchange
    from config import (AGENT_BRIDGE_PATH, COUNCIL_DIR, DEBATE_ROUNDS, INVESTIGATE_TURNS, PROJECT_ROOT,
                        RUNS_FILE, VERDICT_ARCHIVE_DIR, VERDICT_FILE, VERDICT_JSON)
    from ledger import archive_verdict, build_outcome, criteria_tally
    from live import BUILD_PHASES, COUNCIL_PHASES, Live
    from personas import AGENT_IDS, SPECIALISTS, persona_prompt

STAGES = ("recall", "plan", "investigate", "debate", "verdict", "record")
# Turn budgets per stage. The structured answer itself costs a turn; 6 proved too tight in a real run.
TURNS = {"plan": 10, "debate": 12, "verdict": 12, "execute": 40, "review": 16}


def human_time(seconds):
    """Compact user-facing duration; raw metrics remain numeric seconds."""
    total = max(0, int(round(float(seconds or 0))))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"
STR, NUM, BOOL = {"type": "string"}, {"type": "number", "minimum": 0, "maximum": 1}, {"type": "boolean"}


def arr(items):
    return {"type": "array", "items": items}


def obj(required, **props):
    return {"type": "object", "properties": props, "required": list(required)}


PLAN = obj(("spoken", "objective", "success_criteria", "assignments"), spoken=STR, objective=STR,
           success_criteria=arr(STR),
           assignments=arr(obj(("agent", "task", "tools_required"),
                               agent={"type": "string", "enum": list(SPECIALISTS)}, task=STR,
                               tools_required=BOOL)))
TAKE = obj(("spoken", "recommendation", "findings", "evidence", "risks", "confidence"), spoken=STR,
           recommendation=STR, findings=arr(STR), evidence=arr(STR), risks=arr(STR), confidence=NUM)
def debate_schema(others):
    """Challenges may only target OTHER councillors (a real run had Ops cross-examining itself)."""
    return obj(("spoken", "challenges", "revised_recommendation", "changed_mind", "confidence"), spoken=STR,
               challenges=arr(obj(("target", "issue"), target={"type": "string", "enum": list(others)}, issue=STR)),
               revised_recommendation=STR, changed_mind=BOOL, confidence=NUM)


DEBATE = debate_schema(SPECIALISTS)
VERDICT = obj(("spoken", "verdict", "decided_by", "dissent", "plan", "success_metrics", "confidence"),
              spoken=STR, verdict=STR, decided_by=arr(STR), dissent=arr(STR), success_metrics=arr(STR),
              confidence=NUM,
              plan=arr(obj(("step", "owner", "done_when"), step=STR, owner={"type": "string", "enum": list(AGENT_IDS)},
                           done_when=STR)))
EXECUTE = obj(("spoken", "done", "changed_files", "blocked"), spoken=STR, changed_files=arr(STR), blocked=arr(STR),
              done=arr(obj(("step", "result"), step=STR, result=STR)))
REVIEW = obj(("spoken", "approved", "issues", "criteria"), spoken=STR, approved=BOOL, issues=arr(STR),
             criteria=arr(obj(("criterion", "met", "how"), criterion=STR, met=BOOL, how=STR)))

TOOLS_NOTE = (f"Repo root: {PROJECT_ROOT}. Shared memory and the hive mind (what other agents did): "
              f'run `node "{AGENT_BRIDGE_PATH}" --recall "<query>"`. Cite evidence you actually checked.')
READ_ONLY_NOTE = "This is deliberation: read, search and verify freely, but change NOTHING (Build acts later)."


def bullets(items):
    return "\n".join(f"- {i}" for i in items) or "- (none)"


class Run:
    """Timing + cost accounting for one council run: the measurable part."""

    def __init__(self, kind, question):
        self.data = {"id": uuid.uuid4().hex[:8], "kind": kind, "question": question[:500],
                     "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "stages": {}, "agents": {}}
        self._t0 = time.monotonic()
        self._stage_t = {}

    def begin(self, stage):
        self._stage_t[stage] = time.monotonic()

    def end(self, stage):
        self.data["stages"][stage] = round(time.monotonic() - self._stage_t.get(stage, self._t0), 1)

    def charge(self, agent, reply):
        a = self.data["agents"].setdefault(agent, {"cost_usd": 0.0, "turns": 0, "seconds": 0.0, "calls": 0,
                                                    "providers": [], "models": []})
        a["cost_usd"] = round(a["cost_usd"] + float(reply.get("costUsd") or 0), 4)
        if reply.get("inputTokens") is not None or reply.get("outputTokens") is not None:
            a["input_tokens"] = a.get("input_tokens", 0) + int(reply.get("inputTokens") or 0)
            a["output_tokens"] = a.get("output_tokens", 0) + int(reply.get("outputTokens") or 0)
            a["token_calls_reported"] = a.get("token_calls_reported", 0) + 1
        a["turns"] += int(reply.get("numTurns") or 0)
        a["seconds"] = round(a["seconds"] + float(reply.get("durationMs") or 0) / 1000, 1)
        a["calls"] += 1
        a.setdefault("attempts", []).extend(reply.get("attempts", []))
        failures = [x for x in reply.get("attempts", []) if x.get("error")]
        if failures:
            a.setdefault("failures", []).extend(failures)
        if reply.get("provider") and reply.get("hasTools", True) and reply["provider"] not in a["providers"]:
            a["providers"].append(reply["provider"])
        if reply.get("model") and reply["model"] not in a["models"]:
            a["models"].append(reply["model"])

    def finish(self, **extra):
        self.data.update(extra)
        self.data["total_s"] = round(time.monotonic() - self._t0, 1)
        self.data["total_cost_usd"] = round(sum(a["cost_usd"] for a in self.data["agents"].values()), 4)
        reported = sum(a.get("token_calls_reported", 0) for a in self.data["agents"].values())
        self.data["input_tokens"] = sum(a.get("input_tokens", 0) for a in self.data["agents"].values()) if reported else None
        self.data["output_tokens"] = sum(a.get("output_tokens", 0) for a in self.data["agents"].values()) if reported else None
        self.data["total_tokens"] = ((self.data["input_tokens"] or 0) + (self.data["output_tokens"] or 0)) if reported else None
        self.data["token_calls_reported"] = reported
        self.data["total_calls"] = sum(a.get("calls", 0) for a in self.data["agents"].values())
        RUNS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(RUNS_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(self.data) + "\n")
        return self.data


class Council:
    def __init__(self, room):
        self.room = room
        self.live = Live(room)

    async def _ask(self, run, agent, prompt, schema, **kw):
        """One structured call with seat animation + cost accounting. Returns (data|None, reply)."""
        await self.room.thinking(agent, True)
        try:
            async with self.live.following(agent) as on_event:
                reply = await ab.ask(agent, prompt, system=persona_prompt(agent), schema=schema,
                                     on_event=on_event, **kw)
        finally:
            await self.room.thinking(agent, False)
        run.charge(agent, reply)
        if reply.get("provider"):
            await self.room.send({"type": "provider", "agent_id": agent, "provider": reply.get("provider"),
                                  "model": reply.get("model", ""), "attempts": reply.get("attempts", [])})
        data = reply.get("data")
        good = bool(reply.get("ok")) and isinstance(data, dict)
        await self.room.send({"type": "activity", "kind": "result", "agent_id": agent, "ok": good})
        if not good:
            await self.room.say(agent, f"_(no structured answer)_ {reply.get('text', '')[:600]}", kind="error")
            return None, reply
        return data, reply

    async def _stage(self, run, name, coro, expected=1):
        run.begin(name)
        await self.room.stage(name, "active")
        await self.live.enter(name, expected)
        try:
            result = await coro
        except Exception:
            await self.room.stage(name, "failed")
            await self.live.leave(name, ok=False)
            raise
        run.end(name)
        await self.room.stage(name, "done", human_time(run.data["stages"][name]))
        await self.live.leave(name)
        return result

    async def _progress(self, phase, message, coro, interval=10):
        """Await a long agent call while giving the browser honest, low-noise heartbeats."""
        task = asyncio.ensure_future(coro)
        started = asyncio.get_running_loop().time()
        await self.room.send({"type": "build_progress", "phase": phase, "state": "active",
                              "elapsed": 0, "message": message})
        try:
            while not task.done():
                done, _ = await asyncio.wait({task}, timeout=interval)
                if not done:
                    elapsed = int(asyncio.get_running_loop().time() - started)
                    await self.room.send({"type": "build_progress", "phase": phase, "state": "active",
                                          "elapsed": elapsed, "message": message})
            return await task
        except BaseException:
            task.cancel()
            raise

    # --- deliberation ---------------------------------------------------------------
    async def _tracked(self, coro, success_outcome):
        """Run one top-level job and always leave the live meter in an honest final state."""
        state = "failed"
        try:
            data = await coro
            state = "complete" if data and data.get("outcome") == success_outcome else "failed"
            return data
        except asyncio.CancelledError:
            state = "cancelled"
            raise
        finally:  # cancel, crash or adjourn: the meter must never be left looking busy
            await self.live.finish(state)

    async def deliberate(self, question, convo=""):
        self.live = Live(self.room, COUNCIL_PHASES)
        return await self._tracked(self._deliberate(question, convo), "verdict")

    async def _deliberate(self, question, convo):
        run = Run("summit", question)
        brief = await self._stage(run, "recall", ab.recall(question))
        memory_lines = max(0, len(brief.splitlines()) - 1)
        await self.room.status(f"recalled {memory_lines} memory/hive lines" if memory_lines else "no prior memory on this")
        context = f"[Council question]\n{question}\n\n[Shared memory + hive mind]\n{brief or '(nothing on file)'}"
        if convo:
            context += f"\n\n[Recent war room conversation]\n{convo}"

        plan, _ = await self._stage(run, "plan", self._ask(run, "main", (
            f"{context}\n\nYou chair the council. Do not answer yet. Pick the specialists this question needs "
            "(1 to 4 of research, comms, content, ops), give each a concrete, checkable sub-task that fits their "
            f"role, and define what a good answer must achieve. For each assignment set tools_required=true ONLY "
            "when that specialist must inspect files, runtime state, shell output, or external evidence. If the user "
            "explicitly says a named role must inspect or verify, you MUST assign that role with tools_required=true. "
            "Assign every specialist explicitly requested by the user. Comms/content perspective work should normally "
            f"be false. Skim at most a file or two; specialists do the digging.\n{TOOLS_NOTE}"),
            PLAN, read_only=True, tools="preferred", max_turns=TURNS["plan"], stage="plan"))
        if not plan or not plan.get("assignments"):
            plan = {"objective": question, "success_criteria": [], "spoken": "Everyone, your view.",
                    "assignments": [{"agent": a, "task": f"Give your {a} perspective.",
                                     "tools_required": a in ("research", "ops")} for a in SPECIALISTS]}
        assigned = {a["agent"]: a for a in plan["assignments"] if a.get("agent") in SPECIALISTS}
        await self.room.say("main", "**Plan:** " + plan["objective"] + "\n\n" + "\n".join(
            f"- **{a}** ({'tools required' if x.get('tools_required') else 'advisory'}): {x['task']}"
            for a, x in assigned.items()), spoken=plan.get("spoken"), kind="plan")

        frame = (f"{context}\n\n[Objective]\n{plan['objective']}\n\n[Success criteria]\n"
                 f"{bullets(plan.get('success_criteria', []))}")
        takes, tooled = {}, {}

        async def investigate(agent):
            take, reply = await self._ask(run, agent, (
                f"{frame}\n\n[Your assignment]\n{assigned[agent]['task']}\n\n{READ_ONLY_NOTE}\n{TOOLS_NOTE}"),
                TAKE, read_only=True, tools="required" if assigned[agent].get("tools_required") else "preferred",
                max_turns=INVESTIGATE_TURNS, stage="investigate")
            if take:
                takes[agent] = take
                tooled[agent] = bool(reply.get("hasTools", True))
                note = "" if tooled[agent] else "\n\n_Answered by a route without tools: nothing here was opened or fetched._"
                await self.room.say(agent, f"{take['recommendation']}\n\n**Findings**\n{bullets(take['findings'])}"
                                    f"\n\n**Evidence**\n{bullets(take['evidence'])}\n\n_confidence "
                                    f"{take['confidence']:.2f}_{note}", spoken=take["spoken"], kind="take")

        await self._stage(run, "investigate", asyncio.gather(*(investigate(a) for a in assigned)),
                          expected=len(assigned))
        failed_specialists = sorted(set(assigned) - set(takes))
        quorum = max(2, (2 * len(assigned) + 2) // 3)
        if len(takes) < quorum:
            return await self._adjourn(run, "no_quorum",
                f"Council adjourned: {len(takes)}/{len(assigned)} specialists answered; {quorum} required. "
                f"Failed: {', '.join(failed_specialists) or 'none'}.",
                assigned_specialists=list(assigned), specialists=list(takes), failed_specialists=failed_specialists)

        successful_providers = sorted({p for a in takes for p in run.data["agents"].get(a, {}).get("providers", [])})
        diversity_warning = (f"Only one provider family answered ({successful_providers[0]}). Treat consensus as "
                             "same-model agreement, not independent corroboration."
                             if len(successful_providers) == 1 and len(takes) > 1 else "")
        if diversity_warning:
            await self.room.status(diversity_warning)

        debates, assessments = {}, {}
        if DEBATE_ROUNDS > 0 and len(takes) > 1:
            async def cross_examine(agent):
                others = "\n".join(f"- {o} (confidence {t['confidence']:.2f}): {t['recommendation']} | findings: "
                                   f"{'; '.join(t['findings'][:4])}" for o, t in takes.items() if o != agent)
                d, reply = await self._ask(run, agent, (
                    f"{frame}\n\n[Your position]\n{takes[agent]['recommendation']}\n\n[The other councillors]\n{others}"
                    "\n\nCross-examine. Challenge the weakest claim another councillor made, with a reason. Concede "
                    "where someone has better evidence. Then give your revised recommendation. You may verify a "
                    f"claim with a quick read. {READ_ONLY_NOTE}"), debate_schema([o for o in takes if o != agent]),
                    read_only=True, tools="preferred", max_turns=TURNS["debate"], stage="debate") 
                if d:
                    debates[agent] = d
                    t = takes[agent]
                    a = assessments[agent] = mindchange.assess(
                        t["confidence"], t["recommendation"], d["confidence"], d["revised_recommendation"],
                        d["changed_mind"], has_tools=bool(reply.get("hasTools", True)))
                    d["confidence"] = a["after"]  # a tool-less route cannot talk a verified position down
                    shift = (f" _(position changed: {'; '.join(a['reasons'])})_" if a["changed"] else
                             " _(claimed a change; none measured)_" if a["claimed"] else "")
                    if a["capped"]:
                        shift += " _(answered without tools, so confidence was held up)_"
                    challenges = "\n".join(f"- to **{c['target']}**: {c['issue']}" for c in d["challenges"])
                    await self.room.say(agent, f"{challenges}\n\n**Revised:** {d['revised_recommendation']}{shift}",
                                        spoken=d["spoken"], kind="critique")

            for _ in range(DEBATE_ROUNDS):
                await self._stage(run, "debate", asyncio.gather(*(cross_examine(a) for a in takes)),
                                  expected=len(takes))
        else:
            await self.room.stage("debate", "skipped")
        debate_failed_specialists = (sorted(set(takes) - set(debates))
                                     if DEBATE_ROUNDS > 0 and len(takes) > 1 else [])

        final_positions = "\n".join(
            f"- {a} (confidence {debates.get(a, t).get('confidence', t['confidence']):.2f}"
            f"{', changed mind (measured)' if assessments.get(a, {}).get('changed') else ''}"
            f"{'' if tooled.get(a, True) else ', NO TOOLS: unverified'}): "
            f"{debates.get(a, {}).get('revised_recommendation') or t['recommendation']}\n  findings: "
            f"{'; '.join(t['findings'][:5])}\n  evidence: {'; '.join(t['evidence'][:5])}\n  risks: {'; '.join(t['risks'][:3])}"
            + "".join(f"\n  challenged {c['target']}: {c['issue']}" for c in debates.get(a, {}).get("challenges", []))
            for a, t in takes.items())
        verdict, _ = await self._stage(run, "verdict", self._ask(run, "main", (
            f"{frame}\n\n[Final positions after cross-examination]\n{final_positions}\n\n"
            f"[Missing assigned specialists]\n{', '.join(failed_specialists) or '(none)'}\n"
            f"[Specialists whose investigation succeeded but debate failed]\n"
            f"{', '.join(debate_failed_specialists) or '(none)'}\n"
            f"[Provider diversity warning]\n{diversity_warning or '(none)'}\n\nDecide only from successful evidence. "
            "Do not invent positions for missing specialists or propose adding fields/features that the supplied "
            "evidence says already exist. Name who convinced you, record real dissent, and produce an executable "
            "plan: ordered steps, each with an owner and a "
            "done_when check someone can verify. Success metrics must be measurable. Decide from the positions "
            "above; open a file only if two councillors contradict each other on a fact."), VERDICT, read_only=True,
            tools="preferred", max_turns=TURNS["verdict"], stage="verdict"))
        if not verdict:
            return await self._adjourn(run, "no_verdict", "Main could not reach a verdict (see the error above). "
                                       "The takes stand in the log; convene again or ask Main directly.")
        await self.room.say("main", f"{verdict['verdict']}\n\n**Decided by:** {', '.join(verdict['decided_by'])}"
                            f"\n\n**Plan**\n" + "\n".join(f"{i}. **{s['owner']}**: {s['step']} _(done when: "
                                                          f"{s['done_when']})_" for i, s in enumerate(verdict['plan'], 1)),
                            spoken=verdict["spoken"], kind="verdict")
        self._save_verdict(question, plan, takes, debates, verdict, run.data["id"])

        hive = [{"agent": a, "action": "council_take", "summary": (debates.get(a, {}).get("revised_recommendation")
                                                                   or t["recommendation"])[:600],
                 "meta": {"run": run.data["id"]}} for a, t in takes.items()]
        hive.append({"agent": "main", "action": "council_verdict", "summary": verdict["verdict"][:800],
                     "meta": {"run": run.data["id"], "question": question[:200]}})
        rec = await self._stage(run, "record", ab.record(question=f"Council question: {question}",
                                                         answer=f"Council verdict: {verdict['verdict']}", hive=hive))
        before = {a: t["confidence"] for a, t in takes.items()}
        final_providers = sorted({p for a in takes for p in run.data["agents"].get(a, {}).get("providers", [])})
        data = run.finish(outcome="verdict", memory_lines_used=memory_lines,
                          assignments=plan["assignments"], assigned_specialists=list(assigned),
                          specialists=list(takes), failed_specialists=failed_specialists,
                          debate_failed_specialists=debate_failed_specialists, providers=final_providers,
                          provider_diversity=len(final_providers),
                          mind_changes=assessments, **mindchange.summarize(assessments),
                          takes_without_tools=sorted(a for a, ok in tooled.items() if not ok),
                          challenges=sum(len(d["challenges"]) for d in debates.values()),
                          evidence=sum(len(t["evidence"]) for t in takes.values()),
                          confidence={a: [before[a], debates.get(a, {}).get("confidence", before[a])] for a in takes},
                          verdict_confidence=verdict["confidence"], plan_steps=len(verdict["plan"]),
                          memories_saved=rec.get("memories", 0), hive_entries=rec.get("hive", 0))
        await self.room.send({"type": "metrics", **data})
        await self.room.status("Verdict locked in. Say BUILD IT (or press Build) to execute the plan.")
        return data

    async def _adjourn(self, run, outcome, why, **extra):
        """Failure still ends the run visibly: status line + scoreboard (never a silent hang)."""
        await self.room.status(why)
        data = run.finish(outcome=outcome, **extra)
        await self.room.send({"type": "metrics", **data})
        return data

    def _save_verdict(self, question, plan, takes, debates, verdict, run_id):
        VERDICT_FILE.parent.mkdir(parents=True, exist_ok=True)
        verdict_json = json.dumps({"run": run_id, "question": question, "objective": plan["objective"],
                                   "success_criteria": plan.get("success_criteria", []), **verdict}, indent=2)
        VERDICT_JSON.write_text(verdict_json, encoding="utf-8")
        takes_md = "\n".join(f"### {a}\n{t['recommendation']}\n\n{bullets(t['findings'])}\n\nEvidence:\n"
                             f"{bullets(t['evidence'])}\n" + (f"\nAfter debate: {debates[a]['revised_recommendation']}\n"
                                                             if a in debates else "") for a, t in takes.items())
        steps = "\n".join(f"{i}. **{s['owner']}**: {s['step']} (done when: {s['done_when']})"
                          for i, s in enumerate(verdict["plan"], 1))
        verdict_md = (
            f"# Summit verdict ({run_id})\n\nQuestion: {question}\n\nObjective: {plan['objective']}\n\n## Takes\n"
            f"{takes_md}\n## Verdict (Main, confidence {verdict['confidence']:.2f})\n{verdict['verdict']}\n\n"
            f"Decided by: {', '.join(verdict['decided_by'])}\n\nDissent:\n{bullets(verdict['dissent'])}\n\n## Plan\n"
            f"{steps}\n\n## Success metrics\n{bullets(verdict['success_metrics'])}\n")
        VERDICT_FILE.write_text(verdict_md, encoding="utf-8")
        archive_verdict(VERDICT_ARCHIVE_DIR, run_id, verdict_json, verdict_md)

    # --- execution ------------------------------------------------------------------
    async def execute(self):
        self.live = Live(self.room, BUILD_PHASES)
        return await self._tracked(self._execute(), "built")

    async def _execute(self):
        if not VERDICT_JSON.exists():
            await self.room.status("No executable verdict on file yet: convene the council first.")
            return None
        v = json.loads(VERDICT_JSON.read_text(encoding="utf-8"))
        run = Run("build", v.get("question", ""))
        out_dir = COUNCIL_DIR / v.get("run", run.data["id"])
        success_metrics = v.get("success_metrics", [])
        run.begin("preflight")
        await self.room.stage("preflight", "active", "checking clean baseline")
        await self.live.enter("preflight", caption="compiling and syntax-checking before anyone edits")
        await self.live.announce("main", "Checking the baseline first. Nobody edits anything until it is clean.")
        preflight = await asyncio.to_thread(build.preflight, sys.executable)
        run.end("preflight")
        await self.live.leave("preflight", ok=preflight["ok"])
        if not preflight["ok"]:
            await self.live.announce("main", "The baseline is already broken, so I stopped. No agent ran and nothing changed.")
            await self.room.stage("preflight", "failed", "baseline is broken")
            await self.room.send({"type": "build_progress", "phase": "preflight", "state": "failed",
                                  "elapsed": 0, "message": "Build stopped before any agent ran.",
                                  "detail": preflight["output"][:2000]})
            data = run.finish(outcome="preflight_failed", changed_files=[], checks_ok=False, approved=False,
                              criteria_met=f"0/{len(success_metrics)}", rebooted=False,
                              failure_summary="Baseline checks failed before execution.",
                              gate_output=preflight["output"][:3000], review_status="not started")
            await self.room.send({"type": "metrics", **data})
            return data
        await self.room.stage("preflight", "done", "baseline clean")
        await self.room.send({"type": "build_progress", "phase": "preflight", "state": "done", "elapsed": 0,
                              "message": "Baseline is clean"})
        owners = list(dict.fromkeys(s["owner"] for s in v.get("plan", [])))
        changed, reports = [], {}
        run.begin("execute")
        await self.room.stage("execute", "active", "starting implementation")
        await self.live.enter("execute", len(owners), f"{len(owners)} owner(s) implementing")
        await self.live.announce("main", f"Baseline is clean. {len(owners)} owner{'s' if len(owners) != 1 else ''} start building: "
                                 + ", ".join(owners) + ".")
        for owner in owners:
            steps = "\n".join(f"- {s['step']} (done when: {s['done_when']})" for s in v["plan"] if s["owner"] == owner)
            r, _ = await self._progress("execute", f"{owner} is implementing its assigned steps", self._ask(run, owner, (
                f"The council decided:\n{v['verdict']}\n\n[Your steps]\n{steps}\n\n[Already done by others]\n"
                + (bullets(f"{o}: {rep['spoken']}" for o, rep in reports.items()) if reports else "- nothing yet")
                + f"\n\nDo your steps now with minimal, surgical changes. Code changes go in the repo, any other "
                f"deliverable goes in {out_dir}. Keep files under 600 lines. Never restart servers, kill processes "
                f"or touch store/. Report every file you changed (repo-relative).\n{TOOLS_NOTE}"),
                EXECUTE, tools="required", max_turns=TURNS["execute"], stage="execute"))
            if r:
                reports[owner] = r
                changed += r["changed_files"]
                unseen, unreported = self.live.tracker(owner).compare(r["changed_files"])
                if unseen or unreported:  # soft: shell edits and non-streaming routes legitimately differ
                    await self.room.status(f"{owner}: report and observed edits differ. Reported but never seen edited: "
                                           f"{', '.join(unseen) or 'none'}. Edited but not reported: "
                                           f"{', '.join(unreported) or 'none'}.")
                await self.room.send({"type": "build_progress", "phase": "execute", "state": "active",
                                      "elapsed": int(run.data["agents"][owner]["seconds"]),
                                      "message": f"{owner} finished; {len(r['changed_files'])} file(s) reported"})
                await self.room.say(owner, "\n".join(f"- {d['step']}: {d['result']}" for d in r["done"])
                                    + (f"\n\n**Blocked:** {'; '.join(r['blocked'])}" if r["blocked"] else ""),
                                    spoken=r["spoken"], kind="build")
            else:
                await self.room.send({"type": "build_progress", "phase": "execute", "state": "failed",
                                      "elapsed": 0, "message": f"{owner} returned no usable build report"})
        run.end("execute")
        execution_failures = [owner for owner in owners if owner not in reports]
        await self.live.leave("execute", ok=not execution_failures)
        await self.room.send({"type": "build_progress", "phase": "execute", "elapsed": 0,
                              "state": "done" if not execution_failures else "failed",
                              "message": f"{len(reports)}/{len(owners)} owners reported; {len(set(changed))} file(s)"})
        await self.room.stage("execute", "done" if not execution_failures else "failed",
                              f"{len(reports)}/{len(owners)} owners; {len(set(changed))} files")
        await self.room.send({"type": "build_progress", "phase": "gate", "state": "active",
                              "elapsed": 0, "message": "Running automated checks"})
        await self.live.announce("main", f"Implementation is in: {len(set(changed))} file{'s' if len(set(changed)) != 1 else ''} "
                                 "changed. Running the automated checks now.")
        gate = await self._stage(run, "gate", asyncio.to_thread(build.gate, changed, sys.executable))
        if execution_failures:
            gate = {"ok": False, "output": gate["output"] + "; missing reports: " + ", ".join(execution_failures)}
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
                                  "state": "done" if review["approved"] else "failed", "elapsed": 0,
                                  "message": "Research approved the build" if review["approved"] else "Research found issues"})
            await self.room.say("research", f"**{'Approved' if review['approved'] else 'Not approved'}**\n\n{met}"
                                + (f"\n\n**Issues**\n{bullets(review['issues'])}" if review["issues"] else ""),
                                spoken=review["spoken"], kind="review")
        rebooted = None
        if gate["ok"] and review and review["approved"] and any(
                f.replace("\\", "/").lstrip("./").startswith("src/") for f in changed):
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
        await ab.record(hive=[{"agent": o, "action": "council_build", "summary": r["spoken"][:600],
                               "meta": {"run": v.get("run"), "files": r["changed_files"][:20]}} for o, r in reports.items()])
        criteria = review["criteria"] if review else []
        approved = bool(review and review["approved"])
        failure = ("" if gate["ok"] and approved else
                   ("Automated checks failed; changes remain on disk but were not activated." if not gate["ok"]
                    else "Research review did not approve the build."))
        changed = list(dict.fromkeys(changed))
        outcome = build_outcome(gate["ok"], approved, changed)
        if outcome == "no_changes":
            failure = ("No file changed, so nothing was built and no review was run. The owner could not edit: "
                       "check that its first working route has tools (Claude or Codex) and that Codex's sandbox works.")
        data = run.finish(outcome=outcome, verdict_run=v.get("run"),
                          changed_files=changed, checks_ok=gate["ok"], approved=approved,
                          criteria_met=criteria_tally(criteria), metrics_total=len(success_metrics),
                          rebooted=bool(rebooted and rebooted["ok"]), failure_summary=failure,
                          gate_output=gate["output"][:3000],
                          review_status="approved" if approved else ("not approved" if review else "skipped"),
                          execution_failures=execution_failures)
        await self.live.announce("main", "Build complete and approved." if outcome == "built" else
                                 f"Build did not succeed. {failure}")
        await self.room.send({"type": "build_progress", "phase": "complete",
                              "state": "done" if outcome == "built" else "failed", "elapsed": 0,
                              "message": "Build completed and approved" if outcome == "built" else failure,
                              "files": changed})
        await self.room.send({"type": "metrics", **data})
        return data
