"""What gets written down when a run is stopped half-way (Cancel, or a crash), so it never just disappears.

Before this a cancelled Build left no ledger row and no saved state: files an owner had already edited were on disk and
nothing said so. Everything here is pure (no I/O, no socket) so the rules can be tested directly.
"""

try:
    from .live import same_file
except ImportError:  # run as a script
    from live import same_file

CANCELLED, CRASHED = "cancelled", "crashed"


def merge_files(reported, observed):
    """Files an owner reported plus any edit the live feed saw, once each (a path may be absolute in one and relative in the other)."""
    merged = list(reported)
    merged += [f for f in observed if not any(same_file(f, m) for m in merged)]
    return merged


def unfinished_owners(owners, reports):
    return [o for o in owners if o not in reports]


def why(outcome, stage, detail=""):
    """One sentence for the ledger and the History page."""
    where = f" during {stage}" if stage else ""
    if outcome == CANCELLED:
        return f"Cancelled{where}."
    return f"Stopped by an error{where}: {detail}"[:300] if detail else f"Stopped by an error{where}."


def ledger_fields(kind, outcome, stage, changed, detail=""):
    """The fields `Run.finish` records. A council has no files and no checks; a build records what it had already changed."""
    fields = {"outcome": outcome, "failure_summary": why(outcome, stage, detail), "interrupted_at": stage or ""}
    if kind == "build":
        fields.update(changed_files=list(changed), checks_ok=False, approved=False, rebooted=False, review_status="not started",
                      headline=build_headline(outcome, stage, changed))
    return fields


def build_headline(outcome, stage, changed):
    n = len(changed)
    edited = f"{n} file{'s' if n != 1 else ''} already changed" if n else "nothing was changed"
    return f"Build {'cancelled' if outcome == CANCELLED else 'stopped by an error'}{' during ' + stage if stage else ''}: {edited}."


def issues(owners, reports, steps_of, changed):
    """What is still wrong, in the list the Fix button hands to Main."""
    todo = [f"{o} never reported: {steps_of(o)}" for o in unfinished_owners(owners, reports)]
    note = [f"The build was stopped before it was checked or reviewed, so none of the {len(changed)} changed file(s) has been tested."] if changed else []
    return todo + note


def build_state(verdict_run, outcome, changed, reports, owners, issue_list, card):
    """The saved state that lets a page (or a later session) continue a stopped Build with Fix. Same shape `_conclude` writes."""
    return {"verdict_run": verdict_run, "outcome": outcome, "changed": list(changed), "reports": reports,
            "missing": unfinished_owners(owners, reports), "checks_ok": False, "gate_output": "", "review": None,
            "issues": issue_list, "actions": ["fix"], "result": card}
