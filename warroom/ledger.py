"""Run-ledger rules: the verdict archive and how a build is judged. Pure functions, unit-tested.

Why this exists: store/summit-verdict.json is overwritten by every summit, so past plans were
unrecoverable, and the build record could not say which plan it executed or whether it changed anything.
"""

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
