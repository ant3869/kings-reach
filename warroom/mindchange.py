"""Did a councillor really change their mind? Measured from the structured answers, not self-reported.

An agent's `changed_mind` boolean is cheap to claim and costs nothing to fake. What we can check is the pair of
positions on either side of the debate: the confidence number and the wording of the recommendation. We keep the
agent's own claim next to the measurement so a disagreement between the two is itself visible.

RULE 2 (v2.14.2). Wording alone is NOT a changed mind: in the first real summit both councillors kept the same
design and only refined details ("2 lines" became "4 lines"), yet 21% word overlap scored as a change. A mind has
changed when confidence moved by CONFIDENCE_MOVE or more, OR the agent claimed a change AND the recommendation
really was rewritten (a claim backed by the text). A rewrite with neither is reported separately as `reworded`.
Limit: a silent stance flip with a small confidence move is not detected; it shows up as `reworded`.

Also here: the guard for tool-less debate answers. A route with no tools cannot open files or sources, so when it
"revises" a tool-verified position it is working from the other councillors' words, not from evidence. It may
still concede, but one round cannot drag confidence down by more than TOOLLESS_MAX_DROP.
"""

import re

CONFIDENCE_MOVE = 0.15     # a shift this big counts as a changed mind on its own
WORDING_SIMILARITY = 0.45  # below this Jaccard overlap the recommendation was rewritten (not necessarily changed)
RULE = 2                   # stored on every ledger row so old rows (rule 1: counted any rewrite) are not misread
TOOLLESS_MAX_DROP = 0.10

_WORD = re.compile(r"[a-z0-9]{3,}")


def _words(text):
    return set(_WORD.findall((text or "").lower()))


def similarity(a, b):
    """Jaccard overlap of the content words in two recommendations (1.0 = same words, 0.0 = nothing shared)."""
    wa, wb = _words(a), _words(b)
    if not wa and not wb:
        return 1.0
    return len(wa & wb) / len(wa | wb)


def guard_confidence(before, claimed, has_tools):
    """(confidence to record, was it capped). Only tool-less answers are capped, and only downward."""
    if has_tools or claimed >= before - TOOLLESS_MAX_DROP:
        return claimed, False
    return round(before - TOOLLESS_MAX_DROP, 4), True


def assess(before_conf, before_text, after_conf, after_text, claimed, has_tools=True):
    """One councillor's change, measured. `changed` is the measurement; `claimed` is what they said."""
    recorded, capped = guard_confidence(before_conf, after_conf, has_tools)
    delta = round(recorded - before_conf, 4)
    sim = round(similarity(before_text, after_text), 3)
    rewritten = sim < WORDING_SIMILARITY
    reasons = []
    if abs(delta) >= CONFIDENCE_MOVE:
        reasons.append(f"confidence {before_conf:.2f} -> {recorded:.2f}")
    if claimed and rewritten:
        reasons.append(f"claimed a change and rewrote the recommendation ({int(sim * 100)}% wording kept)")
    return {"before": before_conf, "after": recorded, "delta": delta, "similarity": sim, "claimed": bool(claimed),
            "changed": bool(reasons), "reworded": rewritten and not reasons, "reasons": reasons, "capped": capped,
            "has_tools": bool(has_tools)}


def summarize(assessments):
    """Roll-up for the ledger: measured count, self-reported count, and who claimed without moving."""
    measured = [a for a, x in assessments.items() if x["changed"]]
    claimed = [a for a, x in assessments.items() if x["claimed"]]
    return {"mind_rule": RULE, "changed_minds": len(measured), "changed_minds_claimed": len(claimed),
            "changed_minds_agents": measured, "reworded_agents": sorted(a for a, x in assessments.items() if x["reworded"]), "claimed_without_change": sorted(set(claimed) - set(measured)),
            "changed_without_claim": sorted(set(measured) - set(claimed))}
