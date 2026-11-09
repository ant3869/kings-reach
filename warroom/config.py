"""War Room configuration. Flat, explicit. Source of truth is the project .env
(same file the Node core reads); real environment variables override it."""

import json
import os
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STORE_DIR = PROJECT_ROOT / "store"


def parse_env_value(raw):
    """'"quoted # kept"' -> inner text; 'bare  # comment' -> 'bare'; '  # c' -> ''. Mirrors src/env.ts."""
    value = raw.strip()
    if value.startswith("#"):
        return ""
    if value[:1] in ("\"", "'"):
        end = value.find(value[0], 1)
        if end > 0:
            return value[1:end]
    match = re.search(r"\s#", value)
    return (value[:match.start()] if match else value).strip()


def _read_env_file(path):
    """Parse KEY=VALUE lines. Never raises; never copies secrets into os.environ."""
    out = {}
    try:
        text = path.read_text(encoding="utf-8-sig")  # .env is saved with a BOM
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = parse_env_value(value)
    return out


_ENV = _read_env_file(PROJECT_ROOT / ".env")


def env(key, default=""):
    """os.environ wins, then .env, then default. Empty strings count as unset."""
    return os.environ.get(key) or _ENV.get(key) or default


WARROOM_PORT = int(env("WARROOM_PORT", "7860"))
DASHBOARD_PORT = int(env("DASHBOARD_PORT", "3141"))
DASHBOARD_TOKEN = env("DASHBOARD_TOKEN")
AGENT_BRIDGE_PATH = env("AGENT_BRIDGE_PATH", str(PROJECT_ROOT / "dist" / "agent-voice-bridge.js"))
# Pin lives with the project (H:), not in the user profile.
PIN_FILE = Path(env("WARROOM_PIN_FILE", str(STORE_DIR / "warroom-pin.json")))
PID_FILE = STORE_DIR / "warroom.pid"
VERDICT_FILE = STORE_DIR / "summit-verdict.md"
VERDICT_JSON = STORE_DIR / "summit-verdict.json"  # machine-readable plan the Build stage executes
BUILD_STATE_JSON = STORE_DIR / "build-state.json"  # where the latest build stopped: what a follow-up (re-check, fix, keep) continues from
VERDICT_ARCHIVE_DIR = STORE_DIR / "verdicts"  # every locked verdict, kept per run id (the plan library)
RUNS_FILE = STORE_DIR / "council-runs.jsonl"  # one metrics line per summit/build: the scoreboard
UPLOADS_DIR = PROJECT_ROOT / "workspace" / "uploads"  # files attached to a message (the dashboard stores them; same folder as Telegram's)
COUNCIL_DIR = PROJECT_ROOT / "workspace" / "council"  # non-code deliverables land here

# --- local voice (free, offline). Models live off C: by default. ---
VOICE_ENABLED = env("WARROOM_VOICE", "on").lower() != "off"
VOICE_MODEL_DIR = Path(env("VOICE_MODEL_DIR", r"D:\models\claudeclaw"))
WHISPER_MODEL = env("WHISPER_MODEL", "distil-large-v3")  # faster-whisper name or local path
WHISPER_DEVICE = env("WHISPER_DEVICE", "cuda")  # cuda -> falls back to cpu automatically
KOKORO_ONNX = Path(env("KOKORO_ONNX", str(VOICE_MODEL_DIR / "kokoro" / "kokoro-v1.0.onnx")))
KOKORO_VOICES = Path(env("KOKORO_VOICES", str(VOICE_MODEL_DIR / "kokoro" / "voices-v1.0.bin")))

# --- council ---
DEBATE_ROUNDS = int(env("COUNCIL_DEBATE_ROUNDS", "1"))  # 0 = skip cross-examination
INVESTIGATE_TURNS = int(env("COUNCIL_INVESTIGATE_TURNS", "24"))  # tool-use budget per specialist

# Browsers may only connect from the dashboard origin (WebSockets ignore CORS, so
# without this any website could drive agents). None = non-browser clients (probes).
ALLOWED_ORIGINS = [
    f"http://{host}:{DASHBOARD_PORT}" for host in ("localhost", "127.0.0.1", "[::1]")
] + [None]


VOICES_FILE = Path(__file__).parent / "voices.json"


def load_voices():
    """Load persona + voice casting from voices.json (single source of truth)."""
    voices_path = VOICES_FILE
    if not voices_path.exists():
        return {}
    with open(voices_path, encoding="utf-8") as fh:
        return json.load(fh)
