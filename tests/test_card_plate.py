"""Card art ships with an empty nameplate (the War Room draws the name and title live).

Unit tests use a synthetic card (no real art touched); one test scans every shipped card and fails if any still has text.
"""

import sys
import unittest
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover - interpreter without the art tooling
    raise unittest.SkipTest("Pillow/numpy not installed in this interpreter")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import card_plate  # noqa: E402

W, H = 426, 626


def synthetic_card(with_text=True) -> Image.Image:
    """Dark plate with a vertical gradient, plus bright blocks standing in for art, emblem, name, title and divider
    at the rows real cards use."""
    base = np.broadcast_to(np.linspace(14, 34, H, dtype=np.float32)[:, None], (H, W))
    rgba = np.dstack([base, base * 0.7, base * 0.35, np.full((H, W), 255, np.float32)]).astype(np.uint8)
    mid = slice(int(W * 0.30), int(W * 0.70))
    rgba[300:340, 40:W - 40, :3] = (200, 180, 140)        # bottom of the portrait
    rgba[350:376, int(W * .43):int(W * .57), :3] = (230, 190, 90)  # emblem
    if with_text:
        rgba[392:420, mid, :3] = (245, 232, 200)           # name
        rgba[432:446, mid, :3] = (240, 225, 190)           # title
        rgba[462:466, int(W * .25):int(W * .75), :3] = (180, 150, 80)  # divider
    return Image.fromarray(rgba, "RGBA")


class BlankPlateTests(unittest.TestCase):
    def test_text_rows_are_repainted_as_plate_and_nothing_else_moves(self):
        before = synthetic_card()
        after = card_plate.blank_plate(before)
        a, b = np.array(before), np.array(after)
        text = (slice(390, 468), slice(int(W * .12), int(W * .88)))
        self.assertGreater(a[text][..., :3].max(), 200)
        self.assertLess(b[text][..., :3].max(), 60, "name, title and divider must be gone")
        self.assertTrue((a[:380] == b[:380]).all(), "portrait and emblem rows are untouched")
        self.assertTrue((a[470:] == b[470:]).all(), "everything below the divider is untouched")
        self.assertTrue((a[..., 3] == b[..., 3]).all(), "alpha (rounded corners) is untouched")

    def test_the_repaint_matches_the_plate_so_there_is_no_visible_patch(self):
        after = np.array(card_plate.blank_plate(synthetic_card())).astype(int)
        clean = np.array(synthetic_card(with_text=False)).astype(int)
        diff = np.abs(after[390:468, :, :3] - clean[390:468, :, :3]).max()
        self.assertLessEqual(diff, 4, "repainted rows should equal the untouched plate colour")

    def test_idempotent_and_a_blank_card_is_left_alone(self):
        once = card_plate.blank_plate(synthetic_card())
        self.assertIsNone(card_plate.text_band(np.array(once)))
        twice = card_plate.blank_plate(once)
        self.assertTrue((np.array(once) == np.array(twice)).all())
        blank = synthetic_card(with_text=False)
        self.assertTrue((np.array(card_plate.blank_plate(blank)) == np.array(blank)).all())

    def test_the_band_never_reaches_into_the_emblem(self):
        top, bottom = card_plate.text_band(np.array(synthetic_card()))
        self.assertGreater(top, 376)
        self.assertGreaterEqual(bottom, 466)


class ShippedArtTests(unittest.TestCase):
    def test_no_shipped_card_still_carries_baked_in_text(self):
        files = card_plate.card_files()
        self.assertGreater(len(files), 200, "card art folders went missing")
        dirty = [p.name for p in files if card_plate.text_band(np.array(Image.open(p).convert("RGBA"))) is not None]
        self.assertEqual(dirty, [], "run: python scripts/card_plate.py")


if __name__ == "__main__":
    unittest.main()
