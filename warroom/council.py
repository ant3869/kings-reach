"""The council: recall -> plan -> investigate -> debate -> verdict -> record, then optional execute.

Every stage returns schema-validated JSON (SDK outputFormat). `spoken` fields are what the
voices say; everything else is evidence for the log, the verdict file and the scoreboard.
Deliberation is read-only (no Write/Edit tools); only execute() may change things.
`room` is the UI sink: stage(), say(), thinking(), status(), send().
"""

import asyncio
import json
import sys
import time
import uuid

try:
    from . import agent_bridge as ab
    from . import build
    from .config import (AGENT_BRIDGE_PATH, COUNCIL_DIR, DEBATE_ROUNDS, INVESTIGATE_TURNS, PROJECT_ROOT,
                         RUNS_FILE, VERDICT_FILE, VERDICT_JSON)
    from .personas import AGENT_IDS, SPECIALISTS, persona_prompt
except ImportError:  # run as a script
    import agent_bridge as ab
    import build
    from config import (AGENT_BRIDGE_PATH, COUNCIL_DIR, DEBATE_ROUNDS, INVESTIGATE_TURNS, PROJECT_ROOT,
                        RUNS_FILE, VERDICT_FILE, VERDICT_JSON)
    from personas import AGENT_IDS, SPECIALISTS, persona_prompt

STAGES = ("recall", "plan", "investigate", "debate", "verdict", "record")
# Turn budgets per stage. The structured answer itself costs a turn; 6 proved too tight in a real run.
TURNS = {"plan": 10, "debate": 12, "verdict": 12, "execute": 40, "review": 16}
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
        a["turns"] += int(reply.get("numTurns") or 0)
        a["seconds"] = round(a["seconds"] + float(reply.get("durationMs") or 0) / 1000, 1)
        a["calls"] += 1
        a.setdefault("attempts", []).extend(reply.get("attempts", []))
        failures = [x for x in reply.get("attempts", []) if x.get("error")]
        if failures:
            a.setdefault("failures", []).extend(failures)
        if reply.get("provider") and reply["provider"] not in a["providers"]:
            a["providers"].append(reply["provider"])
        if reply.get("model") and reply["model"] not in a["models"]:
            a["models"].append(reply["model"])

    def finish(self, **extra):
        self.data.update(extra)
        self.data["total_s"] = round(time.monotonic() - self._t0, 1)
        self.data["total_cost_usd"] = round(sum(a["cost_usd"] for a in self.data["agents"].values()), 4)
        RUNS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(RUNS_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(self.data) + "\n")
        return self.data


class Council:
    def __init__(self, room):
        self.room = room

    async def _ask(self, run, agent, prompt, schema, **kw):
        """One structured call with seat animation + cost accounting. Returns (data|None, reply)."""
        await self.room.thinking(agent, True)
        try:
            reply = await ab.ask(agent, prompt, system=persona_prompt(agent), schema=schema, **kw)
        finally:
            await self.room.thinking(agent, False)
        run.charge(agent, reply)
        if reply.get("provider"):
            await self.room.send({"type": "provider", "agent_id": agent, "provider": reply.get("provider"),
                                  "model": reply.get("model", ""), "attempts": reply.get("attempts", [])})
        data = reply.get("data")
        if not reply.get("ok") or not isinstance(data, dict):
            await self.room.say(agent, f"_(no structured answer)_ {reply.get('text', '')[:600]}", kind="error")
            return None, reply
        return data, reply

    async def _stage(self, run, name, coro):
        run.begin(name)
        await self.room.stage(name, "active")
        try:
            result = await coro
        except Exception:
            await self.room.stage(name, "failed")
            raise
        run.end(name)
        await self.room.stage(name, "done", f"{run.data['stages'][name]}s")
        return result

    # --- deliberation ---------------------------------------------------------------
    async def deliberate(self, question, convo=""):
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
            PLAN, read_only=True, tools="preferred", max_turns=TURNS["plan"]))
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
        takes = {}

        async def investigate(agent):
            take, _ = await self._ask(run, agent, (
                f"{frame}\n\n[Your assignment]\n{assigned[agent]['task']}\n\n{READ_ONLY_NOTE}\n{TOOLS_NOTE}"),
                TAKE, read_only=True, tools="required" if assigned[agent].get("tools_required") else "preferred",
                max_turns=INVESTIGATE_TURNS)
            if take:
                takes[agent] = take
                await self.room.say(agent, f"{take['recommendation']}\n\n**Findings**\n{bullets(take['findings'])}"
                                    f"\n\n**Evidence**\n{bullets(take['evidence'])}\n\n_confidence "
                                    f"{take['confidence']:.2f}_", spoken=take["spoken"], kind="take")

        await self._stage(run, "investigate", asyncio.gather(*(investigate(a) for a in assigned)))
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

        debates = {}
        if DEBATE_ROUNDS > 0 and len(takes) > 1:
            async def cross_examine(agent):
                others = "\n".join(f"- {o} (confidence {t['confidence']:.2f}): {t['recommendation']} | findings: "
                                   f"{'; '.join(t['findings'][:4])}" for o, t in takes.items() if o != agent)
                d, _ = await self._ask(run, agent, (
                    f"{frame}\n\n[Your position]\n{takes[agent]['recommendation']}\n\n[The other councillors]\n{others}"
                    "\n\nCross-examine. Challenge the weakest claim another councillor made, with a reason. Concede "
                    "where someone has better evidence. Then give your revised recommendation. You may verify a "
                    f"claim with a quick read. {READ_ONLY_NOTE}"), debate_schema([o for o in takes if o != agent]),
                    read_only=True, tools="preferred", max_turns=TURNS["debate"]) 
                if d:
                    debates[agent] = d
                    shift = " _(changed position)_" if d["changed_mind"] else ""
                    challenges = "\n".join(f"- to **{c['target']}**: {c['issue']}" for c in d["challenges"])
                    await self.room.say(agent, f"{challenges}\n\n**Revised:** {d['revised_recommendation']}{shift}",
                                        spoken=d["spoken"], kind="critique")

            for _ in range(DEBATE_ROUNDS):
                await self._stage(run, "debate", asyncio.gather(*(cross_examine(a) for a in takes)))
        else:
            await self.room.stage("debate", "skipped")
        debate_failed_specialists = (sorted(set(takes) - set(debates))
                                     if DEBATE_ROUNDS > 0 and len(takes) > 1 else [])

        final_positions = "\n".join(
            f"- {a} (confidence {debates.get(a, t).get('confidence', t['confidence']):.2f}"
            f"{', changed mind' if debates.get(a, {}).get('changed_mind') else ''}): "
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
            tools="preferred", max_turns=TURNS["verdict"]))
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
        data = run.finish(outcome="verdict", memory_lines_used=memory_lines,
                          assignments=plan["assignments"], assigned_specialists=list(assigned),
                          specialists=list(takes), failed_specialists=failed_specialists,
                          debate_failed_specialists=debate_failed_specialists, providers=successful_providers,
                          provider_diversity=len(successful_providers),
                          changed_minds=sum(d["changed_mind"] for d in debates.values()),
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
        VERDICT_JSON.write_text(json.dumps({"run": run_id, "question": question, "objective": plan["objective"],
                                            "success_criteria": plan.get("success_criteria", []), **verdict},
                                           indent=2), encoding="utf-8")
        takes_md = "\n".join(f"### {a}\n{t['recommendation']}\n\n{bullets(t['findings'])}\n\nEvidence:\n"
                             f"{bullets(t['evidence'])}\n" + (f"\nAfter debate: {debates[a]['revised_recommendation']}\n"
                                                             if a in debates else "") for a, t in takes.items())
        steps = "\n".join(f"{i}. **{s['owner']}**: {s['step']} (done when: {s['done_when']})"
                          for i, s in enumerate(verdict["plan"], 1))
        VERDICT_FILE.write_text(
            f"# Summit verdict ({run_id})\n\nQuestion: {question}\n\nObjective: {plan['objective']}\n\n## Takes\n"
            f"{takes_md}\n## Verdict (Main, confidence {verdict['confidence']:.2f})\n{verdict['verdict']}\n\n"
            f"Decided by: {', '.join(verdict['decided_by'])}\n\nDissent:\n{bullets(verdict['dissent'])}\n\n## Plan\n"
            f"{steps}\n\n## Success metrics\n{bullets(verdict['success_metrics'])}\n", encoding="utf-8")

    # --- execution ------------------------------------------------------------------
    async def execute(self):
        if not VERDICT_JSON.exists():
            await self.room.status("No executable verdict on file yet: convene the council first.")
            return None
        v = json.loads(VERDICT_JSON.read_text(encoding="utf-8"))
        run = Run("build", v.get("question", ""))
        out_dir = COUNCIL_DIR / v.get("run", run.data["id"])
        owners = list(dict.fromkeys(s["owner"] for s in v.get("plan", [])))
        changed, reports = [], {}
        for owner in owners:
            steps = "\n".join(f"- {s['step']} (done when: {s['done_when']})" for s in v["plan"] if s["owner"] == owner)
            await self.room.stage("execute", "active", owner)
            r, _ = await self._ask(run, owner, (
                f"The council decided:\n{v['verdict']}\n\n[Your steps]\n{steps}\n\n[Already done by others]\n"
                + (bullets(f"{o}: {rep['spoken']}" for o, rep in reports.items()) if reports else "- nothing yet")
                + f"\n\nDo your steps now with minimal, surgical changes. Code changes go in the repo, any other "
                f"deliverable goes in {out_dir}. Keep files under 600 lines. Never restart servers, kill processes "
                f"or touch store/. Report every file you changed (repo-relative).\n{TOOLS_NOTE}"),
                EXECUTE, tools="required", max_turns=TURNS["execute"]) 
            if r:
                reports[owner] = r
                changed += r["changed_files"]
                await self.room.say(owner, "\n".join(f"- {d['step']}: {d['result']}" for d in r["done"])
                                    + (f"\n\n**Blocked:** {'; '.join(r['blocked'])}" if r["blocked"] else ""),
                                    spoken=r["spoken"], kind="build")
        await self.room.stage("execute", "done")
        gate = await self._stage(run, "gate", asyncio.to_thread(build.gate, changed, sys.executable))
        await self.room.status(("checks passed: " if gate["ok"] else "checks FAILED: ") + gate["output"][:1500])
        review, _ = await self._stage(run, "review", self._ask(run, "research", (
            f"Review the council's build.\n[Verdict]\n{v['verdict']}\n\n[Success metrics]\n"
            f"{bullets(v.get('success_metrics', []))}\n\n[Reports]\n" + "\n".join(
                f"- {o}: {json.dumps(r['done'])[:1200]}" for o, r in reports.items())
            + f"\n\n[Changed files]\n{bullets(changed)}\n[Automated checks]\n{gate['output'][:1500]}\n\nOpen the changed "
            f"files and verify each success metric yourself. {READ_ONLY_NOTE}\n{TOOLS_NOTE}"), REVIEW,
            read_only=True, tools="required", max_turns=TURNS["review"]))
        if review:
            met = "\n".join(f"- {'PASS' if c['met'] else 'FAIL'} {c['criterion']}: {c['how']}" for c in review["criteria"])
            await self.room.say("research", f"**{'Approved' if review['approved'] else 'Not approved'}**\n\n{met}"
                                + (f"\n\n**Issues**\n{bullets(review['issues'])}" if review["issues"] else ""),
                                spoken=review["spoken"], kind="review")
        rebooted = None
        if gate["ok"] and any(f.replace("\\", "/").lstrip("./").startswith("src/") for f in changed):
            await self.room.status("core code changed and checks pass: rebooting core...")
            rebooted = await asyncio.to_thread(build.reboot_core)
            await self.room.status(("core rebooted: " if rebooted["ok"] else "reboot FAILED: ") + rebooted["detail"])
        if any(f.replace("\\", "/").lstrip("./").startswith("warroom/") for f in changed):
            await self.room.status("war room code changed: restart the war room to load it.")
        await ab.record(hive=[{"agent": o, "action": "council_build", "summary": r["spoken"][:600],
                               "meta": {"run": v.get("run"), "files": r["changed_files"][:20]}} for o, r in reports.items()])
        criteria = review["criteria"] if review else []
        data = run.finish(outcome="built" if gate["ok"] and review and review["approved"] else "needs_work",
                          changed_files=changed, checks_ok=gate["ok"], approved=bool(review and review["approved"]),
                          criteria_met=f"{sum(c['met'] for c in criteria)}/{len(criteria)}",
                          rebooted=bool(rebooted and rebooted["ok"]))
        await self.room.send({"type": "metrics", **data})
        return data
