"""Pure-logic tests for the war room (no models, no network). Run via npm test -> tests/warroom.test.mjs."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import router  # noqa: E402
from council import DEBATE, PLAN, TAKE, VERDICT, debate_schema  # noqa: E402
from personas import SPECIALISTS, get_persona  # noqa: E402
from voice import sentence_chunks, speakable  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
