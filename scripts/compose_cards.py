"""Mix-and-match: put the cut-out characters on the empty card backdrops -> public/card-states/composed/.

    python scripts/compose_cards.py [--sheet DIR]      (run build_new_sets.py first)

Output: composed/<pose>-<backdrop>-<role>.webp, e.g. offense-obscured-ops.webp. 10 poses x 2 backdrops x 5 roles.

How the character gets *behind* the nameplate, emblem and frame: the character may only paint inside a fixed art
window (measured off the 426x626 frames with a ruler overlay): inside the border, above the nameplate's shallow arc,
minus the emblem disc and the two top corner ornaments. The two empty frames are separate generations, so diffing
them to find the window does not work (their nameplates differ too).
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_card_art as art  # noqa: E402
from build_new_sets import ROLES, save_art, sheet  # noqa: E402

CARDS = art.ROOT / "public" / "card-states"
BACKDROPS = ("detail", "obscured")
POSES = ("idle", "thinking", "thinking2", "thinking3", "talking", "explaining", "offense", "defense", "defeated", "defeated2")
W, H = art.SIZE
WINDOW_LEFT, WINDOW_RIGHT, WINDOW_TOP = 16, 410, 16
PANEL_CENTRE_Y, PANEL_EDGE_Y = 330, 358  # the nameplate's top edge arcs down towards the sides
EMBLEM = (213, 318, 47)  # x, y, radius of the medallion that straddles the panel edge
CORNER = 46  # top corner ornaments
HEAD_ROOM = 10  # px between the window top and the top of the head
# The strip cut the busts off flat at their left/right edges, so they must fill the window width or the cut shows:
# these are intentionally close-up portraits (an intense-moment variant, not a drop-in for the wide cards).
FILL = 1.04


def load(path: Path) -> Image.Image:
    return Image.open(path).convert("RGBA")


def art_window() -> Image.Image:
    """'L' mask: 255 where the character may paint."""
    ys, xs = np.mgrid[0:H, 0:W]
    bend = ((xs - W / 2) / ((WINDOW_RIGHT - WINDOW_LEFT) / 2)) ** 2
    panel_top = PANEL_CENTRE_Y + (PANEL_EDGE_Y - PANEL_CENTRE_Y) * bend
    inside = (xs >= WINDOW_LEFT) & (xs <= WINDOW_RIGHT) & (ys >= WINDOW_TOP) & (ys <= panel_top)
    ex, ey, er = EMBLEM
    inside &= (xs - ex) ** 2 + (ys - ey) ** 2 > er ** 2
    inside &= ~(((xs < WINDOW_LEFT + CORNER) | (xs > WINDOW_RIGHT - CORNER)) & (ys < WINDOW_TOP + CORNER))
    return Image.fromarray((inside * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))


def compose(person: Image.Image, backdrop: Image.Image, window: Image.Image) -> Image.Image:
    width = round((WINDOW_RIGHT - WINDOW_LEFT) * FILL)
    person = person.resize((width, round(person.height * width / person.width)), Image.LANCZOS)
    layer = Image.new("RGBA", backdrop.size, (0, 0, 0, 0))
    layer.alpha_composite(person, ((WINDOW_LEFT + WINDOW_RIGHT - width) // 2, WINDOW_TOP + HEAD_ROOM))
    alpha = np.asarray(layer.getchannel("A")).astype(np.float32) * np.asarray(window).astype(np.float32) / 255.0
    layer.putalpha(Image.fromarray(alpha.astype(np.uint8)))
    return Image.alpha_composite(backdrop, layer)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", help="directory for review contact sheets")
    args = ap.parse_args()
    out_dir = CARDS / "composed"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.webp"):
        stale.unlink()
    made = 0
    window = art_window()
    for backdrop_name in BACKDROPS:
        rows = {pose: [] for pose in POSES}
        for role in ROLES:
            frames = {n: load(CARDS / "frames" / f"{n}-{role}.webp") for n in BACKDROPS}
            for pose in POSES:
                card = compose(load(CARDS / "chars" / f"{pose}-{role}.webp"), frames[backdrop_name], window)
                rows[pose].append(save_art(card, out_dir / f"{pose}-{backdrop_name}-{role}"))
                made += 1
        if args.sheet:
            for pose, files in rows.items():
                sheet(files, Path(args.sheet) / f"composed-{backdrop_name}-{pose}.png")
    print(f"composed: {made} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
