"""Rebuild every logo size from the one source crest. Run: python scripts/make-brand.py  (needs Pillow).

public/brand/kr-crest-source.png is the artwork (transparent background). Everything else in public/brand/ is made from it:
trimmed to the artwork's real edges, centred on a transparent square (never stretched), then resized. The tiny sizes use a tighter
crop of the shield alone, because at 16-48 px the laurels and ribbon only turn the picture to mud.
"""
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "brand"
SHIELD = (0.13, 0.0, 0.88, 1.0)  # left, top, right, bottom as a share of the trimmed crest: the shield without laurels/ribbon tips
ICO_SIZES = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]  # the desktop shortcut and taskbar
TAB_SIZES = [(s, s) for s in (16, 24, 32, 48)]  # the browser tab: small, because every page load can ask for it


def square(img, margin=0.04, size=None, background=None):
    """Centre on a square canvas with a little air around it. `background` None = transparent."""
    side = int(max(img.size) * (1 + 2 * margin))
    canvas = Image.new("RGBA", (side, side), background or (0, 0, 0, 0))
    canvas.alpha_composite(img, ((side - img.width) // 2, (side - img.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS) if size else canvas


def main():
    src = Image.open(OUT / "kr-crest-source.png").convert("RGBA")
    full = src.crop(src.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox())
    w, h = full.size
    shield = full.crop((int(w * SHIELD[0]), 0, int(w * SHIELD[2]), h))

    square(full, size=512).save(OUT / "kr-crest-512.png", optimize=True)
    square(full, size=256).save(OUT / "kr-crest-256.webp", quality=92, method=6)  # War Room header
    square(shield, size=96).save(OUT / "kr-crest-96.webp", quality=92, method=6)  # the nav seal (shown at 36-44 px, so 2x)
    square(shield, size=32).save(OUT / "favicon-32.png", optimize=True)
    # iOS ignores transparency (it paints black), so the touch icon gets the app's own dark background.
    square(full, margin=0.1, size=180, background=(11, 13, 18, 255)).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    big = square(shield, margin=0.02, size=256)
    big.save(OUT / "kings-reach.ico", sizes=ICO_SIZES)  # NOT served to browsers: the shortcut points at this file
    big.save(OUT / "favicon.ico", sizes=TAB_SIZES)
    for p in sorted(OUT.iterdir()):
        print(f"{p.name:24} {p.stat().st_size:>8} bytes")


if __name__ == "__main__":
    main()
