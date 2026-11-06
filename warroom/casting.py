"""Who speaks with which voice. voices.json stays the single source of truth; this module lists the voices the local
Kokoro model really has and changes a seat's voice only to one of them (so a typo or a stale name can never be saved).

Only English voices are offered: the room speaks with lang="en-us", and a Spanish or Japanese voice reading English
sounds broken. Kokoro names are <accent><gender>_<name>: af/am American, bf/bm British.
"""

import json
import os
from pathlib import Path

import numpy as np

try:
    from . import personas
    from .config import KOKORO_VOICES, VOICES_FILE
except ImportError:  # run as a script: python warroom/server.py
    import personas
    from config import KOKORO_VOICES, VOICES_FILE

GROUPS = {"af": "American female", "am": "American male", "bf": "British female", "bm": "British male"}
_listing = {"path": None, "mtime": None, "voices": []}


def available_voices() -> list:
    """[{id, name, group}] from the voice file Kokoro loads (English only, grouped, sorted); [] if it is missing."""
    path = Path(KOKORO_VOICES)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    if _listing["path"] != str(path) or _listing["mtime"] != mtime:
        with np.load(path, allow_pickle=True) as data:  # same trusted local file kokoro-onnx itself loads
            names = list(data.files)
        voices = [{"id": n, "name": n.split("_", 1)[1].title(), "group": GROUPS[n[:2]]}
                  for n in names if n[:2] in GROUPS and "_" in n]
        voices.sort(key=lambda v: (list(GROUPS.values()).index(v["group"]), v["name"]))
        _listing.update(path=str(path), mtime=mtime, voices=voices)
    return _listing["voices"]


def current() -> dict:
    return {agent: personas.get_persona(agent)["kokoro_voice"] for agent in personas.AGENT_IDS}


def casting_message() -> dict:
    return {"type": "casting", "voices": available_voices(), "current": current()}


def set_voice(agent_id, voice) -> dict:
    """Give a seat a new voice: validated, written to voices.json atomically, live for the very next sentence."""
    if agent_id not in personas.AGENT_IDS:
        raise ValueError(f"unknown agent: {agent_id}")
    if voice not in {v["id"] for v in available_voices()}:
        raise ValueError(f"{voice} is not a voice this machine has")
    data = json.loads(Path(VOICES_FILE).read_text(encoding="utf-8"))
    data.setdefault(agent_id, {})["kokoro_voice"] = voice
    tmp = Path(str(VOICES_FILE) + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, VOICES_FILE)  # a crash mid-write must never leave half a casting file
    personas._CAST.setdefault(agent_id, {})["kokoro_voice"] = voice
    return current()
