"""The per-run spend limit: pure rules, no I/O, so they can be tested without a War Room.

COUNCIL_MAX_COST_USD caps what ONE council or Build may spend. It is off unless set to a positive number. It is checked
between stages (a Build: before each owner starts), so a stage already running finishes and the last one can overshoot.
It counts only costs the providers REPORT (Claude reports every call; Codex, Gemini and others only sometimes), so the
real bill can be higher. The message says so rather than pretend to be exact.
"""

import math


class SpendLimitReached(Exception):
    """Raised between stages once a run has spent its limit. Council._tracked handles it: a stop, not an error."""


def setting(raw):
    """(limit, note) from the raw setting. `limit` is dollars, or None for off.

    `note` is non-empty when a value WAS given but cannot be used. Saying so matters: a cap you believe you have and do not is
    worse than no cap, so a typo like 2usd must never fail silently into "off". Blank and 0 are an explicit, silent off."""
    text = str(raw or "").strip()
    if not text:
        return None, ""
    try:
        value = float(text.lstrip("$"))
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 0:
        return None, f"COUNCIL_MAX_COST_USD={text!r} is not a positive number, so there is NO spend limit."
    return (value, "") if value > 0 else (None, "")


def over(spent, limit):
    return limit is not None and spent >= limit


def stopped_message(spent, limit, where):
    return (f"${spent:.2f} spent against a ${limit:.2f} limit (checked {where}). Only costs the providers report are counted, "
            "so the real bill may be higher. Everything said so far stays in the log.")
