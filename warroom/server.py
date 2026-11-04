"""War Room server (ws://127.0.0.1:7860): the council chamber's transport. Logic lives in council.py.

Browser -> server
  JSON  {"type": "text"|"summit"|"build"|"pin"|"ping"|"voice"|"hush"|"cancel", ...}
  bytes one utterance, 16 kHz mono int16 PCM -> local Whisper -> handled exactly like typed text
Server -> browser
  JSON  {"agent_id", "text", "kind"} chat line | {"type": "stage"|"thinking"|"transcript"|"metrics"|"voice"
        |"activity" (what an agent is doing right now) |"meter" (overall progress estimate)}
        | {"ok": true, ...} | {"error": "..."}       (agent_id "war-room" = status line)
  bytes  <json header>\n<WAV>  one spoken clip: header {"agent_id", "seq"}

Single instance is structural: SO_EXCLUSIVEADDRUSE bind before anything else; pid file after.
"""

import asyncio
import json
import os
import re
import socket
import sys

import websockets

try:
    from . import agent_bridge as ab
    from .config import ALLOWED_ORIGINS, PID_FILE, WARROOM_PORT
    from .council import STAGES, Council
    from .personas import persona_prompt
    from .router import COUNCIL, read_pin, route, write_pin
    from .voice import Voice
except ImportError:  # run as a script: python warroom/server.py
    import agent_bridge as ab
    from config import ALLOWED_ORIGINS, PID_FILE, WARROOM_PORT
    from council import STAGES, Council
    from personas import persona_prompt
    from router import COUNCIL, read_pin, route, write_pin
    from voice import Voice

PROTOCOL = "council-v4"  # bump only when the wire protocol changes (v4: activity + meter messages)
SERVER_VERSION = 13  # bump on every server.py deploy; shown in the client via pong
NARRATION_BACKLOG = 1  # commentary never queues behind more than this many pending clips
HISTORY_TURNS = 8
WORK_LOCK = asyncio.Lock()  # one council or build at a time, across all tabs
BUILD_RE = re.compile(r"^\s*(build it|build|execute( the plan)?|make it so)[.!]*\s*$", re.IGNORECASE)
VOICE = Voice()
SESSIONS = set()


def log(*parts):
    print("[warroom]", *parts, flush=True)


class Session:
    """One browser tab: history, send lock, speech queue, background tasks. Also the council's `room`."""

    def __init__(self, websocket):
        self.ws = websocket
        self.history = []
        self.tasks = set()
        self.voice_on = False
        self.speech = asyncio.Queue()
        self._seq = 0
        self._send_lock = asyncio.Lock()
        self.speaker = asyncio.create_task(self._speak_loop())

    async def send(self, obj):
        async with self._send_lock:
            await self.ws.send(json.dumps(obj) if isinstance(obj, dict) else obj)

    # --- the council's room interface ------------------------------------------------
    async def status(self, text):
        await self.send({"agent_id": "war-room", "text": text})

    async def stage(self, name, state, detail=""):
        await self.send({"type": "stage", "stage": name, "state": state, "detail": detail})

    async def thinking(self, agent_id, on):
        await self.send({"type": "thinking", "agent_id": agent_id, "on": on})

    async def say(self, agent_id, text, spoken=None, kind="reply"):
        self.history.append((agent_id, spoken or text))
        await self.send({"agent_id": agent_id, "text": text, "kind": kind})
        if self.voice_on and (spoken or text):
            self.speech.put_nowait((agent_id, spoken or text))

    async def narrate(self, agent_id, text):
        """Running commentary: always in the live feed; spoken only if voice is on and nothing important is queued."""
        await self.send({"type": "activity", "kind": "narration", "agent_id": agent_id, "text": text})
        if self.voice_on and self.speech.qsize() <= NARRATION_BACKLOG:
            self.speech.put_nowait((agent_id, text))

    # --- speech ---------------------------------------------------------------------
    async def _speak_loop(self):
        """Serial: agents never talk over each other. Clips go out as soon as each sentence is ready."""
        while True:
            agent_id, text = await self.speech.get()
            try:
                async for wav in VOICE.speak(agent_id, text):
                    self._seq += 1
                    header = json.dumps({"agent_id": agent_id, "seq": self._seq}).encode("utf-8")
                    await self.send(header + b"\n" + wav)
            except websockets.ConnectionClosed:
                return
            except Exception as exc:  # noqa: BLE001 - a bad clip never stops the room
                log("tts failed:", repr(exc)[:200])

    def hush(self):
        while not self.speech.empty():
            self.speech.get_nowait()

    # --- work -----------------------------------------------------------------------
    def spawn(self, coro, label):
        async def guarded():
            try:
                try:
                    await coro
                except asyncio.CancelledError:
                    await self.status(f"{label} cancelled.")
                except Exception as exc:  # noqa: BLE001 - one bad turn never drops the client
                    if isinstance(exc, websockets.ConnectionClosed):
                        raise
                    log(f"{label} FAILED:", repr(exc)[:300])
                    await self.send({"agent_id": "main", "text": f"{label} failed: {exc}", "kind": "error"})
            except websockets.ConnectionClosed:
                pass  # the tab left; nobody to tell

        task = asyncio.create_task(guarded())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def convo(self):
        return "\n".join(f"{who}: {what[:400]}" for who, what in self.history[-HISTORY_TURNS:])

    async def answer(self, agent_id, text):
        await self.thinking(agent_id, True)
        try:
            reply = await ab.ask(agent_id, (
                f"[War Room conversation so far]\n{self.convo()}\n\nUser said: {text}\n\n"
                "Answer in under 80 words of plain speech (it is read aloud). Use your tools if the answer "
                "needs facts you can check."), system=persona_prompt(agent_id), memory_query=text, max_turns=12)
        finally:
            await self.thinking(agent_id, False)
        self.history.append(("you", text))
        await self.say(agent_id, reply.get("text") or "(no reply)", kind="reply" if reply.get("ok") else "error")
        if reply.get("ok"):
            self.spawn(ab.record(question=text, answer=reply["text"], agent=agent_id), "Memory")

    async def exclusive(self, label, coro):
        if WORK_LOCK.locked():
            coro.close()
            await self.status(f"The council is already in session; {label} waits its turn (or press Cancel).")
            return
        async with WORK_LOCK:
            await coro

    async def handle_text(self, text, kind="text"):
        if BUILD_RE.match(text):
            kind = "build"
        target, rest = route(text)
        if kind == "build":
            self.spawn(self.exclusive("build", Council(self).execute()), "Build")
        elif kind == "summit" or target == COUNCIL:
            question = rest if target == COUNCIL else text
            self.history.append(("you", question))
            log("council convened, chars:", len(question))
            self.spawn(self.exclusive("summit", Council(self).deliberate(question, self.convo())), "Council")
        else:
            log(f"text -> {target}, chars:", len(rest))
            self.spawn(self.answer(target, rest), "Reply")

    async def handle_audio(self, pcm):
        text = await VOICE.transcribe(pcm)
        await self.send({"type": "transcript", "text": text})
        if text:
            log("heard, chars:", len(text))
            await self.handle_text(text)

    async def dispatch(self, payload):
        kind = payload.get("type")
        text = str(payload.get("text", "")).strip()
        if kind == "ping":
            await self.send({"ok": True, "pong": PROTOCOL, "server": SERVER_VERSION, "pid": os.getpid(),
                             "stages": list(STAGES), "pinned": read_pin()})
        elif kind == "pin":
            write_pin(payload.get("agent_id"))
            await self.send({"ok": True, "pinned": read_pin()})
        elif kind == "voice":
            self.voice_on = bool(payload.get("on"))
            await self.send(VOICE.info())
        elif kind == "hush":
            self.hush()
        elif kind == "cancel":
            self.hush()
            for task in list(self.tasks):
                task.cancel()
        elif kind in ("text", "summit") and text:
            await self.handle_text(text, kind)
        elif kind == "build":
            await self.handle_text("build it", "build")
        elif kind not in ("text", "summit"):
            await self.send({"error": f"unknown message type: {kind}"})

    def close(self):
        self.speaker.cancel()
        for task in list(self.tasks):
            task.cancel()  # kills the agent subprocesses too


async def handle_client(websocket):
    session = Session(websocket)
    SESSIONS.add(session)
    log("client connected")
    try:
        await session.status(f"Welcome to the War Room (server v{SERVER_VERSION}, {PROTOCOL}).")
        await session.send(VOICE.info())
        async for raw in websocket:
            if isinstance(raw, bytes):
                session.spawn(session.handle_audio(raw), "Listening")
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await session.send({"error": "message must be JSON"})
                continue
            await session.dispatch(payload)
    except websockets.ConnectionClosed:
        pass  # tab closed / network blip: normal, not a traceback
    finally:
        SESSIONS.discard(session)
        session.close()
    log("client disconnected")


async def warm_voice():
    info = await VOICE.warm()
    log("voice:", info["state"], "-", info["detail"])
    for s in list(SESSIONS):
        try:
            await s.send(info)
        except websockets.ConnectionClosed:
            pass


def claim_port():
    """Bind exclusively. Returns a listening socket, or None if anyone else holds the port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)  # Windows
    if exclusive is not None:
        sock.setsockopt(socket.SOL_SOCKET, exclusive, 1)
    try:
        sock.bind(("127.0.0.1", WARROOM_PORT))
    except OSError as exc:
        sock.close()
        log(f"cannot bind :{WARROOM_PORT} ({exc}); another war room is running - exiting")
        return None
    sock.listen(128)
    sock.setblocking(False)
    return sock


def release_pid_file():
    try:
        if PID_FILE.read_text(encoding="utf-8").strip() == str(os.getpid()):
            PID_FILE.unlink()
    except OSError:
        pass


async def main():
    sock = claim_port()
    if sock is None:
        return 1
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    try:
        async with websockets.serve(handle_client, sock=sock, origins=ALLOWED_ORIGINS, max_size=16 * 2 ** 20):
            log(f"listening on ws://127.0.0.1:{WARROOM_PORT} pid={os.getpid()} "
                f"server v{SERVER_VERSION} python={sys.executable}")
            warmer = asyncio.create_task(warm_voice())  # noqa: F841 - keep a reference, runs in background
            await asyncio.Future()
    finally:
        release_pid_file()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        release_pid_file()
