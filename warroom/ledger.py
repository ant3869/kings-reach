"""Run-ledger rules: the verdict archive and how a build is judged. Pure functions, unit-tested.

Why this exists: store/summit-verdict.json is overwritten by every summit, so past plans were
unrecoverable, and the build record could not say which plan it executed or whether it changed anything.
It also decides what the user is TOLD about a build (state, headline, issues, the options that make sense), so that
wording is testable and lives in one place rather than being scattered through the pipeline.
"""

import json
import re
from pathlib import Path

RUN_ID = re.compile(r"^[0-9a-f]{8}$")


def archive_verdict(archive_dir: Path, run_id: str, json_text: str, md_text: str) -> None:
    """Keep an immutable copy of a locked verdict under <archive_dir>/<run_id>.{json,md}."""
    if not RUN_ID.match(run_id):
        raise ValueError(f"bad run id: {run_id!r}")
    archive_dir.mkdir(parents=True, exist_ok=True)
    (archive_dir / f"{run_id}.json").write_text(json_text, encoding="utf-8")
    (archive_dir / f"{run_id}.md").write_text(md_text, encoding="utf-8")


def criteria_tally(criteria: list) -> str:
    """'met/total' over the criteria the reviewer actually returned (it was divided by the verdict's
    metric count before, which produced nonsense like 18/7)."""
    return f"{sum(1 for c in criteria if c.get('met'))}/{len(criteria)}"


def build_outcome(gate_ok: bool, approved: bool, changed: list) -> str:
    """'built' needs green checks, an approving review AND at least one changed file. A build that changed
    nothing built nothing: 'no_changes', whether or not anyone reviewed it (the review is skipped when there is
    nothing to review; a real run once paid $0.67 for Research to "approve" an empty build)."""
    if gate_ok and not changed:
        return "no_changes"
    return "built" if gate_ok and approved else "needs_work"


# --- what the user is told -------------------------------------------------------------------------------------------
def build_state(outcome: str, checks_ok: bool) -> str:
    """The final state of a Build run: complete | attention | failed.

    'attention' is green checks but a reviewer that is not satisfied: the work is on disk and passed every automated
    check, so it needs a human decision, not a rebuild. Showing that in the same red FAILED as 'the checks broke' or
    'the baseline was already broken' told the user nothing about whether their files were safe or what to do."""
    if outcome == "built":
        return "complete"
    return "attention" if outcome == "needs_work" and checks_ok else "failed"


def _files(changed: list) -> str:
    return f"{len(changed)} file{'' if len(changed) == 1 else 's'}"


def build_headline(outcome: str, checks_ok: bool, changed: list, tally: str = "", failure: str = "", accepted: bool = False) -> tuple:
    """(headline, detail): one plain sentence for the title and a short paragraph that answers 'what happened to my files?'."""
    if outcome == "built" and accepted:
        return ("Kept as you decided",
                f"{_files(changed)} changed and kept. The automated checks passed; Research had not approved, and you accepted the work as it is.")
    if outcome == "built":
        return "Built and approved", f"{_files(changed)} changed. The automated checks passed and Research approved the work."
    if outcome == "preflight_failed":
        return ("Stopped before anything was edited",
                "The project was already failing its own checks, so no agent ran and no file changed. Fix that first, then build again.")
    if outcome == "no_changes":
        return "Nothing was built", failure or "No file changed."
    if checks_ok:
        return ("Built, but Research is not satisfied",
                f"The checks passed and {_files(changed)} changed. Your files are kept exactly as written and nothing has been "
                f"restarted. Research could confirm {tally or 'only some'} of the success criteria. You decide what happens next.")
    if not changed:
        return ("An owner did not finish",
                "No file was changed and at least one owner never reported back, so nothing was checked, reviewed or restarted.")
    return ("The automated checks failed",
            f"{_files(changed)} changed and are kept on disk, but they did not pass the checks, so nothing was reviewed or restarted.")


# What each follow-up costs and does, in the user's words. Server and page share these, so they cannot drift apart.
FOLLOWUPS = {
    "review": {"label": "Re-check only",
               "hint": "Research looks at the files again. Nothing is edited. The cheapest option; useful if you changed something yourself."},
    "fix": {"label": "Fix what was flagged",
            "hint": "The Hand of the King fixes only the issues listed here, then the checks and the review run again. Nothing already done is redone."},
    "accept": {"label": "Keep as is",
               "hint": "Accept the files as they are. Free. Restarts the core if the changes need it."},
}


def build_followups(outcome: str, checks_ok: bool, changed: list, unfinished: bool = False) -> list:
    """Which follow-ups make sense. Only a build that left changes behind, or steps nobody finished, can be continued; a
    build whose checks failed must be fixed (re-checking or accepting failing code makes no sense)."""
    if outcome != "needs_work" or not (changed or unfinished):
        return []
    return ["review", "fix", "accept"] if checks_ok else ["fix"]


def build_issues(review, unreported: dict, extra=()) -> list:
    """Everything still wrong, in one list the page shows and the fixer is given: what could not be done, what the
    reviewer flagged, and every success criterion it could not confirm."""
    issues = list(extra)
    issues += [f"{owner} never reported back, so these steps may be unfinished: {steps}" for owner, steps in unreported.items()]
    if review:
        issues += list(review.get("issues") or [])
        issues += [f"Not confirmed: {c['criterion']} ({c['how']})" for c in review.get("criteria") or [] if not c.get("met")]
    return issues


# --- continuing a build -------------------------------------------------------------------------------------------------
def save_build_state(path: Path, state: dict) -> None:
    """What a follow-up needs to carry on from where the last build stopped. One file: only the latest build can be continued."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state), encoding="utf-8")


def load_build_state(path: Path):
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) else None
