"""Pure-logic tests for the war room (no models, no network). Run via npm test -> tests/warroom.test.mjs."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import router  # noqa: E402
from council import DEBATE, PLAN, TAKE, VERDICT, debate_schema, human_time  # noqa: E402
from ledger import archive_verdict, build_outcome, criteria_tally  # noqa: E402
from personas import SPECIALISTS, get_persona  # noqa: E402
from voice import sentence_chunks, speakable  # noqa: E402


class DurationTests(unittest.TestCase):
    def test_human_time(self):
        self.assertEqual(human_time(701.4), "11m 41s")
        self.assertEqual(human_time(59.2), "59s")
        self.assertEqual(human_time(3661), "1h 1m 1s")


class RouteTests(unittest.TestCase):
    def test_council_prefix_strips_trigger(self):
        self.assertEqual(router.route("Council, should we ship the voice stack?", pinned=""),
                         (router.COUNCIL, "should we ship the voice stack?"))
        self.assertEqual(router.route("hey council what next", pinned="")[0], router.COUNCIL)

    def test_named_agent(self):
        self.assertEqual(router.route("hey Ops, check the disk", pinned=""), ("ops", "check the disk"))
        self.assertEqual(router.route("@research: find X", pinned=""), ("research", "find X"))
        # what Whisper actually produces for spoken wake phrases
        self.assertEqual(router.route("Hey, Research, reply with ALIVE.", pinned=""), ("research", "reply with ALIVE."))
        self.assertEqual(router.route("Okay. Council, what now?", pinned=""), (router.COUNCIL, "what now?"))

    def test_bare_mention_is_not_a_route(self):
        # "team"/"council" mid-sentence must not hijack a normal reply
        self.assertEqual(router.route("tell the team I said hi", pinned="")[0], "main")
        self.assertEqual(router.route("operations are fine", pinned="")[0], "main")

    def test_pin_and_default(self):
        self.assertEqual(router.route("status?", pinned="comms"), ("comms", "status?"))
        self.assertEqual(router.route("status?", pinned=""), ("main", "status?"))

    def test_trigger_alone_falls_through(self):
        self.assertEqual(router.route("council", pinned="")[0], "main")


class VoiceTextTests(unittest.TestCase):
    def test_speakable_drops_markup_and_code(self):
        out = speakable("## Plan\n- **ship** it\n```py\nrm -rf /\n```\nsee [docs](https://x.y) or https://z.q")
        self.assertNotIn("rm -rf", out)
        self.assertNotIn("*", out)
        self.assertNotIn("https", out)
        self.assertIn("ship it", out)
        self.assertIn("docs", out)

    def test_speakable_caps_length(self):
        self.assertLessEqual(len(speakable("This is a sentence. " * 200)), 900)

    def test_first_chunk_short_for_fast_start(self):
        chunks = sentence_chunks("One short line. " + "Then a much longer sentence follows here. " * 8)
        self.assertLessEqual(len(chunks[0]), 140)
        self.assertEqual(" ".join(chunks).split(), ("One short line. " + "Then a much longer sentence follows here. " * 8).split())


class SchemaTests(unittest.TestCase):
    def test_every_stage_has_spoken_line(self):
        for schema in (PLAN, TAKE, DEBATE, VERDICT):
            self.assertIn("spoken", schema["required"])

    def test_plan_only_assigns_specialists(self):
        enum = PLAN["properties"]["assignments"]["items"]["properties"]["agent"]["enum"]
        self.assertEqual(sorted(enum), sorted(SPECIALISTS))

    def test_debate_cannot_target_self(self):
        enum = debate_schema(["research", "comms"])["properties"]["challenges"]["items"]["properties"]["target"]["enum"]
        self.assertEqual(enum, ["research", "comms"])

    def test_every_persona_has_a_voice(self):
        for agent in ("main", *SPECIALISTS):
            self.assertTrue(get_persona(agent)["kokoro_voice"])


class CardArtTests(unittest.TestCase):
    """The served card art must be complete, uniform and share the idle layout (the audit's two root causes:
    nobody measured the pixels, and the cards did not line up)."""

    @classmethod
    def setUpClass(cls):
        try:
            import numpy  # noqa: F401
            from PIL import Image  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("Pillow/numpy not installed in this interpreter")
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
        import build_card_art
        cls.art = build_card_art

    def test_every_state_card_exists_at_2x_with_transparent_corners(self):
        from PIL import Image
        for state in ("thinking", "speaking", "building"):
            for role in ("main", "research", "comms", "content", "ops"):
                path = self.art.OUT / f"{state}-{role}.png"
                self.assertTrue(path.exists(), f"missing {path.name}")
                img = Image.open(path).convert("RGBA")
                self.assertEqual(img.size, self.art.SIZE, path.name)
                self.assertEqual(img.getpixel((0, 0))[3], 0, f"{path.name}: corner should be transparent")
                self.assertEqual(img.getpixel((img.width // 2, img.height // 2))[3], 255, path.name)

    def test_state_cards_share_the_idle_nameplate_layout(self):
        self.assertEqual(self.art.layout_report(self.art.OUT, 0.02), 0)


class LedgerTests(unittest.TestCase):
    def test_criteria_tally_counts_returned_criteria_not_verdict_metrics(self):
        # regression: 18 reviewer criteria over 7 verdict metrics used to print "18/7"
        criteria = [{"met": True}] * 18 + [{"met": False}] * 2
        self.assertEqual(criteria_tally(criteria), "18/20")
        self.assertEqual(criteria_tally([]), "0/0")

    def test_build_outcome_needs_a_changed_file_to_count_as_built(self):
        self.assertEqual(build_outcome(True, True, ["src/a.ts"]), "built")
        self.assertEqual(build_outcome(True, True, []), "no_changes")  # approved, built nothing
        self.assertEqual(build_outcome(False, True, ["src/a.ts"]), "needs_work")
        self.assertEqual(build_outcome(True, False, ["src/a.ts"]), "needs_work")

    def test_archive_verdict_keeps_one_copy_per_run_and_rejects_bad_ids(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "verdicts"
            archive_verdict(archive, "a1b2c3d4", '{"run": "a1b2c3d4"}', "# md")
            self.assertEqual((archive / "a1b2c3d4.json").read_text(encoding="utf-8"), '{"run": "a1b2c3d4"}')
            self.assertEqual((archive / "a1b2c3d4.md").read_text(encoding="utf-8"), "# md")
            for bad in ("../evil", "A1B2C3D4", "short", ""):
                with self.assertRaises(ValueError):
                    archive_verdict(archive, bad, "{}", "")


if __name__ == "__main__":
    unittest.main()
