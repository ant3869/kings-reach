"""Did a councillor really change their mind? Measured from the structured answers, not self-reported.

An agent's `changed_mind` boolean is cheap to claim and costs nothing to fake. What we can check is the pair of
positions on either side of the debate: the confidence number and the wording of the recommendation. We keep the
agent's own claim next to the measurement so a disagreement between the two is itself visible.

Also here: the guard for tool-less debate answers. A route with no tools cannot open files or sources, so when it
"revises" a tool-verified position it is working from the other councillors' words, not from evidence. It may
still concede, but one round cannot drag confidence down by more than TOOLLESS_MAX_DROP.
"""

import re

CONFIDENCE_MOVE = 0.15     # a shift this big counts as a changed mind on its own
WORDING_SIMILARITY = 0.45  # below this Jaccard overlap the recommendation is a different recommendation
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
    reasons = []
    if abs(delta) >= CONFIDENCE_MOVE:
        reasons.append(f"confidence {before_conf:.2f} -> {recorded:.2f}")
    if sim < WORDING_SIMILARITY:
        reasons.append(f"recommendation rewritten ({int(sim * 100)}% wording kept)")
    return {"before": before_conf, "after": recorded, "delta": delta, "similarity": sim, "claimed": bool(claimed),
            "changed": bool(reasons), "reasons": reasons, "capped": capped, "has_tools": bool(has_tools)}


def summarize(assessments):
    """Roll-up for the ledger: measured count, self-reported count, and who claimed without moving."""
    measured = [a for a, x in assessments.items() if x["changed"]]
    claimed = [a for a, x in assessments.items() if x["claimed"]]
    return {"changed_minds": len(measured), "changed_minds_claimed": len(claimed),
            "changed_minds_agents": measured, "claimed_without_change": sorted(set(claimed) - set(measured)),
            "changed_without_claim": sorted(set(measured) - set(claimed))}
