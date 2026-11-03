"""Route typed or spoken input to the right agent. Priority rules, simplest first.

Rule 1: starts with "council" / "summit"  -> full council deliberation.
Rule 2: name prefix ("hey Comms", "Research,", "@ops") -> that agent.
Rule 3: pinned agent (persisted pin file) -> pinned agent.
Rule 4: default -> main.
"""

import json
import re

try:
    from .config import PIN_FILE
    from .personas import AGENT_IDS
except ImportError:  # run as a script: python warroom/server.py
    from config import PIN_FILE
    from personas import AGENT_IDS

COUNCIL = "council"
_NAMES = "|".join(AGENT_IDS)
# Whisper punctuates speech: "Hey, Research, ..." must route like "hey research ...".
_WAKE = r"(?:(?:hey|ok|okay|alright)\b[\s,.!]*|@)?"
COUNCIL_RE = re.compile(rf"^\s*{_WAKE}(?:the\s+)?(?:council|summit)\b[\s,:.!-]*", re.IGNORECASE)
NAME_RE = re.compile(rf"^\s*{_WAKE}({_NAMES})\b[\s,:.!-]+", re.IGNORECASE)


def read_pin():
    """Return the pinned agent id, or None if nothing is pinned."""
    try:
        with open(PIN_FILE, encoding="utf-8") as fh:
            agent_id = json.load(fh).get("agent_id")
        return agent_id if agent_id in AGENT_IDS else None
    except (OSError, ValueError, AttributeError):
        return None


def write_pin(agent_id):
    """Pin an agent (or None to clear). Pinning is a nicety: never fail over it."""
    try:
        if agent_id in AGENT_IDS:
            PIN_FILE.write_text(json.dumps({"agent_id": agent_id}), encoding="utf-8")
        else:
            PIN_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def route(text, pinned=None):
    """-> (target, remaining_text). target is an agent id or COUNCIL. Pure except the pin default."""
    council = COUNCIL_RE.match(text)
    if council and text[council.end():].strip():
        return COUNCIL, text[council.end():].strip()
    named = NAME_RE.match(text)
    if named and text[named.end():].strip():
        return named.group(1).lower(), text[named.end():].strip()
    pin = pinned if pinned is not None else read_pin()
    return (pin or "main"), text.strip()
