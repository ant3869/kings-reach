"""Prep the 'new_set' art drop: split strips into per-role files, remove backgrounds, normalise sizes.

    python scripts/build_new_sets.py                 # -> public/card-states/sets/<set>/ , chars/ , frames/
    python scripts/build_new_sets.py --sheet DIR     # also write one contact sheet per set/state for review

Input (assets-src/new_set/, moved out of public/ so the 70 MB of originals are never served):
    set_1/<state>.png, set_2/<state>.png   five finished cards side by side on white  -> sets/<set>/<state>-<role>.png
    chars/<pose>.png                       five characters on chroma green            -> chars/<pose>-<role>.png
    empty_cards_*.png                      five empty frames on white                 -> frames/<kind>-<role>.png

Cards reuse build_card_art.cut_out (border flood-fill + fringe shave + 426x626), so they match the existing art.
"""

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_card_art as art  # noqa: E402

DROP = art.ROOT / "assets-src" / "new_set"
OUT = art.ROOT / "public" / "card-states"
ROLES = art.ROLES  # left-to-right order in every strip
CHAR_HEIGHT = 640


def save_art(image: Image.Image, dest: Path) -> Path:
    """WebP keeps alpha at roughly a tenth of the PNG size (160 files would otherwise be ~75 MB of served art)."""
    dest = dest.with_suffix(".webp")
    image.save(dest, "WEBP", quality=92, alpha_quality=100, method=6)
    return dest


def spans(occupied: np.ndarray, min_width: int) -> list:
    """Consecutive True stretches wider than min_width, as (start, end)."""
    found, start = [], None
    for i, v in enumerate(list(occupied) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_width:
                found.append((start, i))
            start = None
    return found


def split_columns(content: np.ndarray, expected: int, name: str) -> list:
    """Cut points between the expected number of subjects; each box runs midpoint-to-midpoint."""
    per_column = content.sum(axis=0)
    found = spans(per_column > 20, min_width=150)
    if len(found) == expected:
        edges = [0] + [(a[1] + b[0]) // 2 for a, b in zip(found, found[1:])] + [content.shape[1]]
    else:
        # Subjects touch or overlap, so there is no empty gap: cut at the emptiest column near each fifth.
        width = content.shape[1]
        slack = width // 12
        edges = [0]
        for k in range(1, expected):
            centre = width * k // expected
            window = per_column[centre - slack:centre + slack]
            edges.append(centre - slack + int(np.argmin(window)))
        edges.append(width)
        print(f"  note: {name} has touching subjects, cut at {edges[1:-1]}")
    return list(zip(edges, edges[1:]))


def split_cards(path: Path) -> list:
    image = Image.open(path).convert("RGB")
    rgb = np.asarray(image)
    boxes = split_columns(rgb.min(axis=2) < 235, len(ROLES), path.name)
    return [image.crop((x0, 0, x1, image.height)) for x0, x1 in boxes]


def key_green(image: Image.Image) -> Image.Image:
    """Chroma-key: soft alpha from how far green exceeds red/blue, then despill the edge pixels.
    A dress or leaf is green but far less saturated than the screen, so the ramp starts well above it."""
    rgb = np.asarray(image.convert("RGB")).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    excess = g - np.maximum(r, b)
    alpha = np.clip((160.0 - excess) / 70.0, 0.0, 1.0)  # >=160 transparent, <=90 opaque (dress/leaf green sits ~70)
    # Hair and edges are lit green by the screen well past the soft matte, so despill a band around it, not just the
    # soft pixels: where green exceeds red/blue near the cut, pull it back to the larger of the two.
    soft = Image.fromarray(((alpha < 1.0) * 255).astype(np.uint8))
    band = np.asarray(soft.filter(ImageFilter.MaxFilter(9))) > 0
    g = np.where(band, np.minimum(g, np.maximum(r, b)), g)
    out = np.dstack([r, g, b, alpha * 255.0]).astype(np.uint8)
    out[alpha == 0, :3] = 0
    return Image.fromarray(out, "RGBA")


def split_chars(path: Path) -> list:
    image = Image.open(path).convert("RGB")
    rgb = np.asarray(image).astype(np.int16)
    not_green = (rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2])) < 150
    boxes = split_columns(not_green, len(ROLES), path.name)
    people = []
    for x0, x1 in boxes:
        person = key_green(image.crop((x0, 0, x1, image.height)))
        bbox = person.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
        person = person.crop(bbox)
        scale = CHAR_HEIGHT / person.height
        # premultiplied resize: no dark or light halo around the cut edge
        people.append(person.convert("RGBa").resize((round(person.width * scale), CHAR_HEIGHT), Image.LANCZOS).convert("RGBA"))
    return people


def sheet(files: list, dest: Path) -> None:
    w, h = art.SIZE[0] // 2, art.SIZE[1] // 2
    page = Image.new("RGBA", (len(files) * (w + 10) + 10, h + 20), (7, 9, 13, 255))
    for i, f in enumerate(files):
        im = Image.open(f).convert("RGBA")
        im = im.resize((round(im.width * h / im.height), h), Image.LANCZOS) if f.parent.name == "chars" else im.resize((w, h), Image.LANCZOS)
        page.alpha_composite(im, (10 + i * (w + 10), 10))
    dest.parent.mkdir(parents=True, exist_ok=True)
    page.convert("RGB").save(dest)


def build_set(set_dir: Path, review: Path | None) -> int:
    count = 0
    out_dir = OUT / "sets" / set_dir.name
    out_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted(set_dir.glob("*.png")):
        row = []
        for role, card in zip(ROLES, split_cards(src)):
            dest = out_dir / f"{src.stem}-{role}.png"
            row.append(save_art(art.cut_out(card), dest))
            count += 1
        if review:
            sheet(row, review / f"{set_dir.name}-{src.stem}.png")
    return count


def build_chars(review: Path | None) -> int:
    count = 0
    out_dir = OUT / "chars"
    out_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted((DROP / "chars").glob("*.png")):
        row = []
        for role, person in zip(ROLES, split_chars(src)):
            dest = out_dir / f"{src.stem}-{role}.png"
            row.append(save_art(person, dest))
            count += 1
        if review:
            sheet(row, review / f"chars-{src.stem}.png")
    return count


def build_frames() -> int:
    count = 0
    out_dir = OUT / "frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    for src in sorted(DROP.glob("empty_cards_*.png")):
        kind = src.stem.replace("empty_cards_", "")
        for role, card in zip(ROLES, split_cards(src)):
            save_art(art.cut_out(card), out_dir / f"{kind}-{role}.png")
            count += 1
    return count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", help="directory for review contact sheets")
    args = ap.parse_args()
    review = Path(args.sheet) if args.sheet else None
    for stale in ("sets", "chars", "frames"):  # outputs are fully regenerated; never leave orphans behind
        shutil.rmtree(OUT / stale, ignore_errors=True)
    total = {s.name: build_set(s, review) for s in sorted(DROP.glob("set_*")) if s.is_dir()}
    total["chars"] = build_chars(review)
    total["frames"] = build_frames()
    for name, n in total.items():
        print(f"{name}: {n} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
