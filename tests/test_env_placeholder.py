"""Copying .env.example to .env is the documented first step. Every value in it is a placeholder, so copying it unchanged must leave
every setting UNSET. Before this was fixed, warroom.config crashed on import: int('YOUR_VALUE_HERE') (WARROOM_PORT, DASHBOARD_PORT,
COUNCIL_DEBATE_ROUNDS and others)."""
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from warroom.config import ENV_PLACEHOLDER, _read_env_file, parse_env_value  # noqa: E402

EXAMPLE = ROOT / ".env.example"


class EnvPlaceholder(unittest.TestCase):
    def test_placeholder_reads_as_unset_bare_quoted_or_commented(self):
        for raw in (ENV_PLACEHOLDER, f"  {ENV_PLACEHOLDER}  ", f'"{ENV_PLACEHOLDER}"', f"'{ENV_PLACEHOLDER}'", f"{ENV_PLACEHOLDER}   # fill me in"):
            self.assertEqual(parse_env_value(raw), "", raw)

    def test_a_real_value_is_never_mistaken_for_the_placeholder(self):
        for raw in ("7860", "sk-live-abc", "YOUR_VALUE_HERE_2", "my YOUR_VALUE_HERE", "your_value_here"):
            self.assertEqual(parse_env_value(raw), raw)

    def test_every_setting_in_the_example_reads_as_unset(self):
        settings = re.findall(r"^\s*([A-Z][A-Z0-9_]{2,})\s*=(.*)$", EXAMPLE.read_text("utf-8"), re.M)
        self.assertGreaterEqual(len(settings), 30)
        live = [f"{k}={v.strip()}" for k, v in settings if parse_env_value(v) != ""]
        self.assertEqual(live, [], "these would be read as real values; ship them as the placeholder, or comment the line out")

    def test_an_env_file_copied_from_the_example_loads_empty(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            copy = Path(d) / ".env"
            copy.write_bytes(EXAMPLE.read_bytes())
            loaded = _read_env_file(copy)
        self.assertGreaterEqual(len(loaded), 30)
        self.assertEqual({k: v for k, v in loaded.items() if v}, {})

    def test_the_war_room_config_imports_after_the_documented_first_step(self):
        """The failure the user actually saw: `copy .env.example .env`, then start. A scratch project root holds a copy of config.py and a
        .env copied from the example, and a fresh interpreter imports it, so config reads that .env exactly as it would for a user.
        (The real .env is never touched.)"""
        import shutil
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "warroom").mkdir()
            shutil.copy(ROOT / "warroom" / "config.py", Path(d) / "warroom" / "config.py")
            (Path(d) / "warroom" / "__init__.py").write_text("")
            shutil.copy(EXAMPLE, Path(d) / ".env")
            code = "import warroom.config as c; print(c.WARROOM_PORT, c.DASHBOARD_PORT, c.DEBATE_ROUNDS, c.INVESTIGATE_TURNS)"
            done = subprocess.run([sys.executable, "-c", code], cwd=d, capture_output=True, text=True, timeout=60,
                                  env={k: v for k, v in __import__("os").environ.items() if not k.startswith(("WARROOM_", "DASHBOARD_", "COUNCIL_"))})
        self.assertEqual(done.returncode, 0, done.stderr[-400:])
        self.assertEqual(done.stdout.split(), ["7860", "3141", "1", "24"])


if __name__ == "__main__":
    unittest.main()
