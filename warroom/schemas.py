"""The council's structured-answer schemas and the fixed prompt notes. Pure data: no I/O, nothing here runs an agent.

council.py and buildflow.py both need these, so they live here rather than in either of them (and council.py
re-exports them, which keeps `council.PLAN` etc. working for the tests and the server).
"""

try:
    from .config import AGENT_BRIDGE_PATH, PROJECT_ROOT
    from .personas import AGENT_IDS, SPECIALISTS
except ImportError:  # run as a script
    from config import AGENT_BRIDGE_PATH, PROJECT_ROOT
    from personas import AGENT_IDS, SPECIALISTS

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
