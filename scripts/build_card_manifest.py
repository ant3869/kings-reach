"""Write public/card-states/manifest.json: which art may represent which card state.

    python scripts/build_card_manifest.py        (run build_new_sets.py and compose_cards.py first)

This file is the ONE place that decides the look. The client's director picks from these pools at random (weighted),
and the server's static allowlist is derived from it, so adding art = drop files + edit POOLS + rerun this script.

A pool entry is [template, weight]; "{role}" is replaced per councillor. set_2 is the owner's preferred primary look,
so it carries the most weight. Composed close-ups (a cut-out character on an empty frame) add variety but are meant
to read as occasional intense moments, so they weigh less.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "public" / "card-states"
ROLES = ("main", "research", "comms", "content", "ops")
# Characters speak in several registers; both poses and both backdrops are used.
BACKDROPS = ("detail", "obscured")


def full(state: str, w2: int = 4, w1: int = 3) -> list:
    return [[f"sets/set_2/{state}-{{role}}.webp", w2], [f"sets/set_1/{state}-{{role}}.webp", w1]]


def composed(pose: str, weight: int = 1) -> list:
    return [[f"composed/{pose}-{b}-{{role}}.webp", weight] for b in BACKDROPS]


POOLS = {
    "idle": full("idle", 5, 3) + composed("idle"),
    "thinking": full("thinking") + composed("thinking") + composed("thinking2") + composed("thinking3"),
    "researching": full("researching"),
    "speaking": full("talking") + full("explaining", 3, 2) + composed("talking") + composed("explaining"),
    "building": full("building"),
    "offense": full("offense") + composed("offense", 2),
    "defense": full("defense") + composed("defense", 2),
    "confused": full("confused"),
    "defeated": full("defeated") + composed("defeated") + composed("defeated2"),
}

# Seconds between swapping to another variant while a state lasts: [min, max]. null = hold (transient states).
ROTATE_SECONDS = {"idle": [24, 55], "thinking": [14, 26], "researching": [14, 26], "speaking": [6, 11],
                  "building": [18, 32], "offense": None, "defense": None, "confused": None, "defeated": None}
# How long a one-shot pose holds before the card returns to its real state (ms).
POSE_MS = {"offense": 7000, "defense": 7000, "confused": 9000, "defeated": 15000}


def main() -> int:
    missing = []
    for state, pool in POOLS.items():
        for template, _ in pool:
            for role in ROLES:
                if not (CARDS / template.format(role=role)).exists():
                    missing.append(template.format(role=role))
    if missing:
        print(f"{len(missing)} referenced files are missing, e.g. {missing[:3]}")
        return 1
    manifest = {"roles": list(ROLES), "pools": POOLS, "rotateSeconds": ROTATE_SECONDS, "poseMs": POSE_MS,
                "fallback": "individual/{state}-{role}.png"}
    (CARDS / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    entries = {s: len(p) for s, p in POOLS.items()}
    print("manifest ok:", entries, f"({sum(entries.values()) * len(ROLES)} files referenced)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
