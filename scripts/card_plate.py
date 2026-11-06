"""Blank the painted-in name, title and divider on a War Room card so the page can draw them live.

    python scripts/card_plate.py                      # blank every shipped card in public/card-states (in place, idempotent)
    python scripts/card_plate.py --check              # report only: how many cards still carry baked-in text
    python scripts/card_plate.py --preview DIR        # write before/after pairs for a few cards, change nothing

Why per card: the art is generated, so the nameplate drifts up to ~14 px (at 270 px card height) between frames; a fixed
cover would either leave letters showing or bite the emblem. Instead each card's own rows are measured: the last three
bright runs below the emblem are the name, the title and the divider. That band is repainted row by row from the plate's
own colour at the left and right margins, so the gold border, the emblem and the plate gradient are untouched.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "public" / "card-states"
FOLDERS = ("individual", "sets", "composed", "frames")  # chars/ are cut-out people with no card around them
BRIGHT = 120  # luminance of painted text/ornament on the dark plate (plate itself stays below ~45)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def middle_profile(rgba: np.ndarray) -> np.ndarray:
    """Brightest pixel of every row across the middle of the card."""
    width = rgba.shape[1]
    return luminance(rgba[:, int(width * 0.22):int(width * 0.78), :3].astype(np.float32)).max(axis=1)


def bright_runs(rgba: np.ndarray) -> list:
    """(first_row, last_row) of each stretch of bright pixels in the middle of the card's lower half."""
    height = rgba.shape[0]
    middle = middle_profile(rgba)
    gap, shortest = max(1, round(height * 0.006)), height * 0.0055
    runs: list = []
    for y in range(int(height * 0.46), int(height * 0.86)):
        if middle[y] <= BRIGHT:
            continue
        if runs and y - runs[-1][1] <= gap:
            runs[-1][1] = y
        else:
            runs.append([y, y])
    return [(a, b) for a, b in runs if b - a + 1 > shortest]


def text_band(rgba: np.ndarray):
    """(top, bottom) rows of name+title+divider, or None when the card has no such text (already blank)."""
    height = rgba.shape[0]
    runs = bright_runs(rgba)
    tail = runs[-3:]  # name, title, divider
    # Where the portrait's bright area runs into the emblem they form one long run: it is art, not text.
    art_like = bool(tail) and tail[0][1] - tail[0][0] > height * 30 / 270
    if art_like:
        tail = tail[1:]
    if len(runs) < 4 and not art_like or len(tail) < 2:  # art/emblem + name + title (+ divider)
        return None
    pad = max(2, round(height * 0.004))
    before = runs[runs.index(tail[0]) - 1] if runs.index(tail[0]) and not art_like else None
    top = tail[0][0] - pad
    if art_like and tail[0][1] - tail[0][0] < height * 14 / 270:  # a lone title line: its name is inside the long art run
        top = tail[0][0] - round(height * 0.083)  # the name sits ~22 px (of 270) above the title
    if before:
        top = max(top, before[1] + 2)  # never reach into the emblem
    bottom = tail[-1][1] + pad
    dim = middle_profile(rgba)  # a faint divider can sit just under the title without ever counting as a bright run
    for y in range(bottom + 1, min(height, bottom + round(height * 0.035))):
        if dim[y] > 60:
            bottom = y + 1
    return top, bottom


def blank_plate(image: Image.Image) -> Image.Image:
    """Return the card with its name, title and divider repainted as plain plate; unchanged if there is none."""
    rgba = np.array(image.convert("RGBA"))
    band = text_band(rgba)
    if band is None:
        return image
    top, bottom = band
    height, width = rgba.shape[:2]
    xl0, xl1, xr0, xr1 = (int(width * f) for f in (0.12, 0.17, 0.83, 0.88))
    x0, x1 = int(width * 0.10), int(width * 0.90)
    across = np.linspace(0.0, 1.0, x1 - x0, dtype=np.float32)[:, None]
    for y in range(top, bottom + 1):
        left = np.median(rgba[y, xl0:xl1, :3], axis=0).astype(np.float32)
        right = np.median(rgba[y, xr0:xr1, :3], axis=0).astype(np.float32)
        rgba[y, x0:x1, :3] = np.rint(left + (right - left) * across).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def card_files() -> list:
    return [p for folder in FOLDERS for p in sorted((CARDS / folder).rglob("*")) if p.suffix.lower() in (".png", ".webp")]


def save_like(image: Image.Image, path: Path) -> None:
    if path.suffix.lower() == ".webp":
        image.save(path, "WEBP", quality=92, alpha_quality=100, method=6)  # same settings the art pipeline ships with
    else:
        image.save(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report only; exit 1 if any card still carries baked-in text")
    ap.add_argument("--preview", help="write before/after strips for a handful of cards into this directory, change nothing")
    args = ap.parse_args()
    files = card_files()
    if args.preview:
        out = Path(args.preview)
        out.mkdir(parents=True, exist_ok=True)
        picks = [CARDS / rel for rel in ("individual/idle-main.png", "sets/set_2/idle-main.webp", "sets/set_1/talking-comms.webp",
                                         "composed/idle-detail-research.webp", "sets/set_2/idle-ops.webp", "sets/set_2/building-research.webp",
                                         "individual/speaking-main.png", "frames/detail-main.webp")]
        for p in picks:
            if p.exists():
                before = Image.open(p).convert("RGBA")
                after = blank_plate(before)
                pair = Image.new("RGBA", (before.width * 2 + 12, before.height), (40, 40, 40, 255))
                pair.alpha_composite(before, (0, 0))
                pair.alpha_composite(after, (before.width + 12, 0))
                pair.convert("RGB").resize((pair.width // 2, pair.height // 2), Image.LANCZOS).save(out / (p.parent.name + "-" + p.stem + ".png"))
        print(f"previews in {out}")
        return 0
    dirty = [p for p in files if text_band(np.array(Image.open(p).convert("RGBA"))) is not None]
    print(f"{len(files)} card images, {len(dirty)} still carry baked-in text")
    if args.check:
        return 1 if dirty else 0
    for p in dirty:
        save_like(blank_plate(Image.open(p)), p)
    print(f"blanked {len(dirty)} card(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
