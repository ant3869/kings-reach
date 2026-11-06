"""Voice casting: only voices the local model has, only known agents, atomic write, live for the next sentence.

Runs against a temp voices.json and a temp Kokoro voice file: it must never touch warroom/voices.json.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "warroom"))

import casting  # noqa: E402
import personas  # noqa: E402


class CastingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        self.bin = tmp / "voices.npz"
        # np.savez appends .npz when missing; write through a file object so the name stays exactly as given
        with open(self.bin, "wb") as fh:
            np.savez(fh, af_heart=np.zeros(1), am_onyx=np.zeros(1), bm_george=np.zeros(1), bf_emma=np.zeros(1),
                     ef_dora=np.zeros(1), jf_alpha=np.zeros(1), zm_yunxi=np.zeros(1))
        self.voices = tmp / "voices.json"
        self.voices.write_text(json.dumps({"main": {"name": "Main", "title": "Hand of the King", "kokoro_voice": "bm_george", "speed": 1.0},
                                           "ops": {"name": "Ops", "title": "Master of War", "kokoro_voice": "am_onyx"}}), encoding="utf-8")
        self.saved = (casting.KOKORO_VOICES, casting.VOICES_FILE, dict(personas._CAST), dict(casting._listing))
        casting.KOKORO_VOICES, casting.VOICES_FILE = self.bin, self.voices
        casting._listing.update(path=None, mtime=None, voices=[])
        personas._CAST.clear()
        personas._CAST.update(json.loads(self.voices.read_text(encoding="utf-8")))

    def tearDown(self):
        casting.KOKORO_VOICES, casting.VOICES_FILE = self.saved[0], self.saved[1]
        personas._CAST.clear()
        personas._CAST.update(self.saved[2])
        casting._listing.update(self.saved[3])
        self.tmp.cleanup()

    def test_only_english_voices_are_offered_grouped_and_named(self):
        voices = casting.available_voices()
        self.assertEqual([v["id"] for v in voices], ["af_heart", "am_onyx", "bf_emma", "bm_george"])
        self.assertEqual(voices[0], {"id": "af_heart", "name": "Heart", "group": "American female"})
        self.assertEqual(voices[3]["group"], "British male")

    def test_missing_voice_file_means_no_choices_not_a_crash(self):
        casting.KOKORO_VOICES = Path(self.tmp.name) / "nope.bin"
        casting._listing.update(path=None, mtime=None, voices=[])
        self.assertEqual(casting.available_voices(), [])
        with self.assertRaises(ValueError):
            casting.set_voice("main", "bm_george")

    def test_a_valid_change_is_saved_and_live_immediately(self):
        now = casting.set_voice("ops", "af_heart")
        self.assertEqual(now["ops"], "af_heart")
        self.assertEqual(personas.get_persona("ops")["kokoro_voice"], "af_heart")  # what Voice.speak reads next sentence
        saved = json.loads(self.voices.read_text(encoding="utf-8"))
        self.assertEqual(saved["ops"]["kokoro_voice"], "af_heart")
        self.assertEqual(saved["ops"]["title"], "Master of War", "nothing else in the file is touched")
        self.assertEqual(saved["main"]["kokoro_voice"], "bm_george")
        self.assertFalse(Path(str(self.voices) + ".tmp").exists(), "no temp file left behind")

    def test_unknown_voice_or_agent_is_refused_and_nothing_changes(self):
        before = self.voices.read_text(encoding="utf-8")
        for agent, voice in (("main", "zm_yunxi"), ("main", "bm_geoorge"), ("main", ""), ("main", None), ("nobody", "bm_george"), (None, "bm_george")):
            with self.assertRaises(ValueError, msg=f"{agent}/{voice}"):
                casting.set_voice(agent, voice)
        self.assertEqual(self.voices.read_text(encoding="utf-8"), before)
        self.assertEqual(personas.get_persona("main")["kokoro_voice"], "bm_george")

    def test_casting_message_lists_voices_and_the_current_cast(self):
        msg = casting.casting_message()
        self.assertEqual(msg["type"], "casting")
        self.assertEqual(msg["current"]["main"], "bm_george")
        self.assertEqual(set(msg["current"]), set(personas.AGENT_IDS))
        self.assertEqual(len(msg["voices"]), 4)


if __name__ == "__main__":
    unittest.main()
