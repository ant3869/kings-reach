"""Turn generated card art into the transparent, uniformly sized assets the War Room serves.

    python scripts/build_card_art.py                 # assets-src/card-states/*.png -> public/card-states/individual/
    python scripts/build_card_art.py --sheet DIR     # also write DIR/sheet-<state>.png: the five roles side by side on a dark page
    python scripts/build_card_art.py --out DIR       # stage into DIR instead of the live folder, review, then copy over

Why flood-fill: the generated cards sit on opaque white with rounded corners. A global "remove near-white" pass
(the old cleaner) also eats the cream title text and highlights, so transparency is only propagated inward from
the image border through near-white pixels. Then a few passes remove the anti-aliased light fringe that hugs the
card edge (only bright pixels directly next to transparency, so the dark frame and gold filigree are untouched).
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from card_plate import blank_plate  # the War Room draws name/title live, so the art ships with an empty nameplate

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "card-states"
OUT = ROOT / "public" / "card-states" / "individual"
LIVE = OUT  # idle cards are never regenerated; they are the layout reference
SIZE = (426, 626)  # 2x the 213x313 CSS-pixel card, so it stays sharp on high-DPI screens
ROLES = ("main", "research", "comms", "content", "ops")
STATES = ("idle", "thinking", "speaking", "building")


def grow(mask: np.ndarray) -> np.ndarray:
    """4-neighbour dilation."""
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """Near-white pixels connected to the image border."""
    lo, hi = rgb.min(axis=2), rgb.max(axis=2)
    candidate = (lo >= 226) & ((hi - lo) <= 24)
    seed = np.zeros_like(candidate)
    seed[0, :] = seed[-1, :] = seed[:, 0] = seed[:, -1] = True
    bg = seed & candidate
    while True:
        nxt = grow(bg) & candidate
        if nxt.sum() == bg.sum():
            return bg
        bg = nxt


def cut_out(image: Image.Image) -> Image.Image:
    rgb = np.asarray(image.convert("RGB")).astype(np.int16)
    bg = background_mask(rgb)
    bright = rgb.min(axis=2) > 168
    for _ in range(4):  # shave the light anti-aliasing ring, one pixel per pass
        bg |= grow(bg) & bright
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb.astype(np.uint8), alpha])
    rgba[bg, :3] = 0  # no white bleeding into edge pixels when downscaling
    ys, xs = np.nonzero(alpha)
    if len(xs) == 0:
        raise ValueError("image is entirely background")
    card = Image.fromarray(rgba, "RGBA").crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    # resize in premultiplied space so edge pixels don't pick up dark or light halos
    return blank_plate(card.convert("RGBa").resize(SIZE, Image.LANCZOS).convert("RGBA"))


def row_profile(path: Path) -> np.ndarray:
    """Cream-pixel count per row (emblem icon, title, subtitle, divider) over the nameplate half of the card."""
    rgba = np.asarray(Image.open(path).convert("RGBA").resize(SIZE)).astype(np.int16)
    band = rgba[:, int(SIZE[0] * 0.22):int(SIZE[0] * 0.78)]
    r, g, b, a = band[..., 0], band[..., 1], band[..., 2], band[..., 3]
    cream = (a > 200) & (r > 200) & (g > 185) & (b > 130) & (r - b < 120)
    rows = cream.sum(axis=1).astype(float)
    rows[: int(SIZE[1] * 0.38)] = 0  # the art area above the emblem is not part of the shared layout
    return rows


def layout_shift(path: Path, idle: Path) -> float:
    """How far (fraction of card height, + = lower) the nameplate content sits from the idle card's.
    Cards share one layout, so this slides the row profile over the idle one and takes the best fit; it does not
    matter which text line happens to be densest."""
    a, b = row_profile(path), row_profile(idle)
    best, best_dy = -1.0, 0
    for dy in range(-int(SIZE[1] * 0.15), int(SIZE[1] * 0.15) + 1):
        score = float(np.dot(np.roll(a, -dy), b))
        if score > best:
            best, best_dy = score, dy
    return best_dy / SIZE[1]


def layout_report(out_dir: Path, tolerance: float) -> int:
    bad = 0
    print(f"nameplate shift vs the idle card (tolerance {tolerance:.3f} of card height; + = lower):")
    for role in ROLES:
        idle = out_dir / f"idle-{role}.png"
        idle = idle if idle.exists() else LIVE / f"idle-{role}.png"
        for state in STATES[1:]:
            f = out_dir / f"{state}-{role}.png"
            if not f.exists():
                continue
            shift = layout_shift(f, idle)
            flag = "OK " if abs(shift) <= tolerance else "BAD"
            bad += flag == "BAD"
            print(f"  {flag} {state:9s}-{role:9s} shift {shift:+.3f} ({shift * 313:+.0f}px at card scale)")
    return bad


def contact_sheet(files: list, dest: Path) -> None:
    """Cards at their on-page size (213x313) over the page's dark background, so fringes and clipping show."""
    w, h = SIZE[0] // 2, SIZE[1] // 2
    page = Image.new("RGBA", (len(files) * (w + 10) + 10, h + 20), (7, 9, 13, 255))
    for i, f in enumerate(files):
        page.alpha_composite(Image.open(f).convert("RGBA").resize((w, h), Image.LANCZOS), (10 + i * (w + 10), 10))
    page.convert("RGB").save(dest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", help="directory for per-state contact sheets (sheet-<state>.png)")
    ap.add_argument("--only", help="process just this state-role, e.g. thinking-research")
    ap.add_argument("--out", default=str(OUT), help="output directory (default: the live served folder)")
    ap.add_argument("--check", action="store_true", help="only report nameplate shift vs idle for --out (exit 1 if any card is off)")
    ap.add_argument("--tolerance", type=float, default=0.02, help="allowed nameplate shift as a fraction of card height")
    args = ap.parse_args()
    out_dir = Path(args.out)
    if args.check:
        return 1 if layout_report(out_dir, args.tolerance) else 0
    out_dir.mkdir(parents=True, exist_ok=True)
    done = []
    for state in STATES:
        for role in ROLES:
            name = f"{state}-{role}"
            src = SRC / f"{name}.png"
            if (args.only and args.only != name) or not src.exists():
                continue
            cut_out(Image.open(src)).save(out_dir / f"{name}.png")
            done.append(out_dir / f"{name}.png")
            print(f"{name}: ok")
    if args.sheet:
        sheet_dir = Path(args.sheet)
        sheet_dir.mkdir(parents=True, exist_ok=True)
        for state in STATES:
            row = [out_dir / f"{state}-{role}.png" for role in ROLES]
            if all(f.exists() for f in row):
                contact_sheet(row, sheet_dir / f"sheet-{state}.png")
    print(f"{len(done)} card(s) built into {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
