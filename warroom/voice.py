"""Local voice: faster-whisper STT (GPU, CPU fallback) + Kokoro TTS (CPU, ~6x realtime). Free, offline.

Measured on this box (RTX 5060 Ti / 7950X): 7 s utterance -> text in 0.21 s warm on CUDA;
7 s of speech synthesized in ~1 s. The first CUDA run JIT-compiles kernels (~20 s), so
warm() runs it at startup and CUDA's kernel cache lives on the model drive, not C:.
"""

import asyncio
import io
import os
import re
import sys
import time
import wave

try:
    from .config import KOKORO_ONNX, KOKORO_VOICES, VOICE_ENABLED, VOICE_MODEL_DIR, WHISPER_DEVICE, WHISPER_MODEL
    from .personas import get_persona
except ImportError:  # run as a script
    from config import KOKORO_ONNX, KOKORO_VOICES, VOICE_ENABLED, VOICE_MODEL_DIR, WHISPER_DEVICE, WHISPER_MODEL
    from personas import get_persona

STT_RATE = 16000
MAX_SPOKEN_CHARS = 900
MIN_UTTERANCE_S = 0.35


def _prepare_cuda():
    """pip's nvidia-cublas/cudnn wheels ship DLLs Windows will not find on its own."""
    os.environ.setdefault("CUDA_CACHE_PATH", str(VOICE_MODEL_DIR / "cuda-cache"))
    os.environ.setdefault("CUDA_CACHE_MAXSIZE", str(2 * 1024 ** 3))
    os.environ.setdefault("HF_HOME", str(VOICE_MODEL_DIR / "hf"))
    for sub in ("cublas", "cudnn"):
        path = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", sub, "bin")
        if os.path.isdir(path):
            os.add_dll_directory(path)
            os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


def speakable(text):
    """Markdown -> something a voice can say. Code is never read aloud."""
    t = re.sub(r"```.*?(```|$)", " ", text or "", flags=re.S)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"https?://\S+", "a link", t)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"^\s*(#+|[-*]|\d+[.)])\s+", "", t, flags=re.M)
    t = re.sub(r"[*_~>|#]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > MAX_SPOKEN_CHARS:
        cut = t.rfind(". ", 0, MAX_SPOKEN_CHARS)
        t = t[: cut + 1 if cut > 200 else MAX_SPOKEN_CHARS]
    return t


def sentence_chunks(text, first_max=140, max_len=320):
    """Short first chunk = the voice starts fast; later chunks merge so it does not sound choppy."""
    parts = [p for p in re.split(r"(?<=[.!?;])\s+", text) if p.strip()]
    chunks, cur = [], ""
    for part in parts:
        limit = first_max if not chunks else max_len
        if cur and len(cur) + len(part) + 1 > limit:
            chunks.append(cur)
            cur = part
        else:
            cur = f"{cur} {part}".strip()
    if cur:
        chunks.append(cur)
    return chunks


def _wav_bytes(samples, rate):
    import numpy as np

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


class Voice:
    """Owns both models. All heavy work runs in threads; one lock per model."""

    def __init__(self):
        self.tts = None
        self.stt = None
        self.stt_device = ""
        self.state = "off" if not VOICE_ENABLED else "loading"
        self.detail = "disabled (WARROOM_VOICE=off)" if not VOICE_ENABLED else "warming up"
        self._tts_lock = asyncio.Lock()
        self._stt_lock = asyncio.Lock()

    def info(self):
        return {"type": "voice", "state": self.state, "tts": self.tts is not None,
                "stt": self.stt is not None, "detail": self.detail}

    def _load(self):
        started = time.monotonic()
        problems = []
        try:
            from kokoro_onnx import Kokoro

            self.tts = Kokoro(str(KOKORO_ONNX), str(KOKORO_VOICES))
        except Exception as exc:  # noqa: BLE001 - voice is optional, the council still works
            problems.append(f"TTS: {exc}")
        try:
            _prepare_cuda()
            from faster_whisper import WhisperModel

            devices = [(WHISPER_DEVICE, "float16")] if WHISPER_DEVICE == "cuda" else []
            for device, ctype in devices + [("cpu", "int8")]:
                try:
                    model = WhisperModel(WHISPER_MODEL, device=device, compute_type=ctype,
                                         download_root=str(VOICE_MODEL_DIR / "hf"))
                    self._warm_stt(model)
                    self.stt, self.stt_device = model, device
                    break
                except Exception as exc:  # noqa: BLE001 - try the next device
                    problems.append(f"STT {device}: {str(exc)[:160]}")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"STT: {exc}")
        parts = []
        if self.stt:
            parts.append(f"ears: whisper {WHISPER_MODEL} on {self.stt_device}")
        if self.tts:
            parts.append("voices: kokoro")
        self.state = "ready" if self.stt and self.tts else ("partial" if self.stt or self.tts else "failed")
        self.detail = f"{', '.join(parts) or 'no voice'} ({time.monotonic() - started:.0f}s warm-up)"
        if problems and self.state != "ready":
            self.detail += " | " + " | ".join(problems)

    def _warm_stt(self, model):
        """Compile CUDA kernels now, not on the user's first sentence."""
        import numpy as np

        if self.tts:
            samples, rate = self.tts.create("The council is assembled.", voice="bm_george", lang="en-us")
            pcm = np.interp(np.arange(0, len(samples), rate / STT_RATE), np.arange(len(samples)), samples)
        else:
            pcm = np.zeros(STT_RATE, dtype=np.float32)
        list(model.transcribe(pcm.astype(np.float32), language="en", beam_size=1)[0])

    async def warm(self):
        if VOICE_ENABLED:
            await asyncio.to_thread(self._load)
        return self.info()

    async def transcribe(self, pcm16le):
        """Raw 16 kHz mono int16 from the browser -> text ('' if nothing was said)."""
        if not self.stt or len(pcm16le) < STT_RATE * 2 * MIN_UTTERANCE_S:
            return ""
        import numpy as np

        audio = np.frombuffer(pcm16le, dtype="<i2").astype(np.float32) / 32768.0

        def run():
            segments, _ = self.stt.transcribe(audio, language="en", beam_size=1, vad_filter=True,
                                              condition_on_previous_text=False)
            return " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()

        async with self._stt_lock:
            return await asyncio.to_thread(run)

    async def speak(self, agent_id, text):
        """Async generator of WAV clips, sentence-chunked so the first clip arrives fast."""
        if not self.tts:
            return
        persona = get_persona(agent_id)
        for chunk in sentence_chunks(speakable(text)):
            async with self._tts_lock:
                samples, rate = await asyncio.to_thread(
                    self.tts.create, chunk, voice=persona["kokoro_voice"], speed=float(persona["speed"]), lang="en-us")
            yield _wav_bytes(samples, rate)
